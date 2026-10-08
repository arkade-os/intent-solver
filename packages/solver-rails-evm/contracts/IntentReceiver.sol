// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Clones} from "./vendor/openzeppelin/proxy/Clones.sol";

interface IERC20ReceiverToken {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface IReceiverERC20Swap {
    function swaps(bytes32 key) external view returns (bool);
    function lock(bytes32 hash, uint256 amount, address token, address claimAddress, address refundAddress, uint256 timelock) external;
}

/// Logic shared by every per-intent receiver. A receiver is a clone whose immutable args are its binding,
/// so it has no constructor: it can be deployed at any time, on any chain, and `recover` always works.
contract IntentReceiver {
    error InvalidBinding();
    error WrongChain();
    error ActivationClosed();
    error AlreadyActivated();
    error InsufficientFunding();
    error ExistingLock();
    error TokenCallFailed();
    error UnexpectedTransfer();
    error ReentrantCall();
    error NothingRecoverable();
    error NotClone();

    struct Binding {
        uint256 chainId;
        address swapContract;
        address token;
        uint256 amount;
        bytes32 preimageHash;
        address claimAddress;
        address refundAddress;
        uint256 activationCutoff;
        uint256 timelock;
        uint256 activationCutoffTimestamp;
    }

    address private immutable self = address(this);
    bool public activated;
    bool private entered;

    event Activated(bytes32 indexed key);
    event Recovered(address indexed recoveredToken, uint256 recoveredAmount);

    modifier guarded() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    function _binding() private view returns (Binding memory) {
        if (address(this) == self) revert NotClone();
        bytes memory args = Clones.fetchCloneArgs(address(this));
        if (args.length != 320) revert InvalidBinding();
        return abi.decode(args, (Binding));
    }

    function _swapKey(Binding memory b) private pure returns (bytes32) {
        return keccak256(abi.encode(b.preimageHash, b.amount, b.token, b.claimAddress, b.refundAddress, b.timelock));
    }

    function chainId() external view returns (uint256) { return _binding().chainId; }
    function swapContract() external view returns (address) { return _binding().swapContract; }
    function token() external view returns (address) { return _binding().token; }
    function amount() external view returns (uint256) { return _binding().amount; }
    function preimageHash() external view returns (bytes32) { return _binding().preimageHash; }
    function claimAddress() external view returns (address) { return _binding().claimAddress; }
    function refundAddress() external view returns (address) { return _binding().refundAddress; }
    function activationCutoff() external view returns (uint256) { return _binding().activationCutoff; }
    function timelock() external view returns (uint256) { return _binding().timelock; }
    function activationCutoffTimestamp() external view returns (uint256) { return _binding().activationCutoffTimestamp; }
    function swapKey() external view returns (bytes32) { return _swapKey(_binding()); }

    function activate() external guarded {
        Binding memory b = _binding();
        if (block.chainid != b.chainId) revert WrongChain();
        if (
            b.swapContract.code.length == 0 || b.token.code.length == 0 ||
            b.amount == 0 || b.preimageHash == bytes32(0) || b.claimAddress == address(0) ||
            b.refundAddress == address(0) || b.claimAddress == b.refundAddress ||
            b.claimAddress == address(this) || b.refundAddress == address(this) ||
            b.swapContract == b.token || b.claimAddress == b.swapContract || b.refundAddress == b.swapContract ||
            b.claimAddress == b.token || b.refundAddress == b.token ||
            b.token == address(this) || b.swapContract == address(this) ||
            b.timelock <= b.activationCutoff
        ) revert InvalidBinding();
        if (activated) revert AlreadyActivated();
        if (block.number >= b.activationCutoff || block.timestamp >= b.activationCutoffTimestamp) revert ActivationClosed();
        IERC20ReceiverToken asset = IERC20ReceiverToken(b.token);
        uint256 beforeBalance = asset.balanceOf(address(this));
        if (beforeBalance < b.amount) revert InsufficientFunding();
        IReceiverERC20Swap destination = IReceiverERC20Swap(b.swapContract);
        bytes32 key = _swapKey(b);
        if (destination.swaps(key)) revert ExistingLock();
        uint256 beforeLocked = asset.balanceOf(b.swapContract);
        activated = true;
        _tokenCall(b.token, abi.encodeCall(asset.approve, (b.swapContract, 0)));
        _tokenCall(b.token, abi.encodeCall(asset.approve, (b.swapContract, b.amount)));
        destination.lock(b.preimageHash, b.amount, b.token, b.claimAddress, b.refundAddress, b.timelock);
        _tokenCall(b.token, abi.encodeCall(asset.approve, (b.swapContract, 0)));
        // Exact deltas are deliberate: fee-on-transfer and rebasing tokens are unsupported, not to be tolerated.
        if (
            !destination.swaps(key) || asset.allowance(address(this), b.swapContract) != 0 ||
            asset.balanceOf(address(this)) != beforeBalance - b.amount ||
            asset.balanceOf(b.swapContract) != beforeLocked + b.amount
        ) revert UnexpectedTransfer();
        emit Activated(key);
    }

    function recover(address recoveredToken) external guarded {
        Binding memory b = _binding();
        if (b.refundAddress == address(0)) revert InvalidBinding();
        // ETH can still be forced in (selfdestruct, block rewards); address(0) sweeps it.
        if (recoveredToken == address(0)) {
            uint256 balance = address(this).balance;
            if (balance == 0) revert NothingRecoverable();
            (bool sent,) = b.refundAddress.call{value: balance}("");
            if (!sent) revert TokenCallFailed();
            emit Recovered(address(0), balance);
            return;
        }
        if (recoveredToken.code.length == 0) revert InvalidBinding();
        IERC20ReceiverToken asset = IERC20ReceiverToken(recoveredToken);
        uint256 beforeBalance = asset.balanceOf(address(this));
        uint256 recoverable = beforeBalance;
        if (
            block.chainid == b.chainId && recoveredToken == b.token && !activated &&
            block.number < b.activationCutoff && block.timestamp < b.activationCutoffTimestamp
        ) {
            if (recoverable <= b.amount) revert NothingRecoverable();
            recoverable -= b.amount;
        }
        if (recoverable == 0) revert NothingRecoverable();
        uint256 beforeRefund = asset.balanceOf(b.refundAddress);
        _tokenCall(recoveredToken, abi.encodeCall(IERC20ReceiverToken.transfer, (b.refundAddress, recoverable)));
        if (
            asset.balanceOf(address(this)) != beforeBalance - recoverable ||
            asset.balanceOf(b.refundAddress) != beforeRefund + recoverable
        ) revert UnexpectedTransfer();
        emit Recovered(recoveredToken, recoverable);
    }

    function _tokenCall(address target, bytes memory data) private {
        (bool ok, bytes memory result) = target.call(data);
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TokenCallFailed();
        }
    }
}

/// Deploys receivers at addresses fixed by their binding. Permissionless: whoever deploys, the clone is the same.
contract IntentReceiverFactory {
    address public immutable implementation = address(new IntentReceiver());

    function receiverOf(bytes calldata args) public view returns (address) {
        return Clones.predictDeterministicAddressWithImmutableArgs(implementation, args, bytes32(0));
    }

    function deploy(bytes calldata args) public returns (address receiver) {
        receiver = receiverOf(args);
        if (receiver.code.length == 0) Clones.cloneDeterministicWithImmutableArgs(implementation, args, bytes32(0));
    }

    function deployAndActivate(bytes calldata args) external returns (address receiver) {
        receiver = deploy(args);
        IntentReceiver(receiver).activate();
    }

    function deployAndRecover(bytes calldata args, address recoveredToken) external returns (address receiver) {
        receiver = deploy(args);
        IntentReceiver(receiver).recover(recoveredToken);
    }
}
