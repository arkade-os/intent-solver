// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

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

    uint256 public immutable chainId;
    address public immutable swapContract;
    address public immutable token;
    uint256 public immutable amount;
    bytes32 public immutable preimageHash;
    address public immutable claimAddress;
    address public immutable refundAddress;
    uint256 public immutable activationCutoff;
    uint256 public immutable activationCutoffTimestamp;
    uint256 public immutable timelock;
    bytes32 public immutable swapKey;
    bool public activated;
    bool private entered;

    event Activated(bytes32 indexed key);
    event Recovered(address indexed recoveredToken, uint256 recoveredAmount);

    constructor(
        uint256 expectedChainId,
        address destinationSwap,
        address destinationToken,
        uint256 requiredAmount,
        bytes32 hash,
        address claimant,
        address solverRefund,
        uint256 cutoffBlock,
        uint256 refundBlock,
        uint256 cutoffTimestamp
    ) {
        if (block.chainid != expectedChainId) revert WrongChain();
        if (
            destinationSwap.code.length == 0 || destinationToken.code.length == 0 ||
            requiredAmount == 0 || hash == bytes32(0) || claimant == address(0) ||
            solverRefund == address(0) || claimant == solverRefund ||
            claimant == address(this) || solverRefund == address(this) ||
            cutoffBlock <= block.number || refundBlock <= cutoffBlock || cutoffTimestamp <= block.timestamp
        ) revert InvalidBinding();
        chainId = expectedChainId;
        swapContract = destinationSwap;
        token = destinationToken;
        amount = requiredAmount;
        preimageHash = hash;
        claimAddress = claimant;
        refundAddress = solverRefund;
        activationCutoff = cutoffBlock;
        activationCutoffTimestamp = cutoffTimestamp;
        timelock = refundBlock;
        swapKey = keccak256(abi.encode(hash, requiredAmount, destinationToken, claimant, solverRefund, refundBlock));
    }

    modifier guarded() {
        if (block.chainid != chainId) revert WrongChain();
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    function activate() external guarded {
        if (activated) revert AlreadyActivated();
        if (block.number >= activationCutoff || block.timestamp >= activationCutoffTimestamp) revert ActivationClosed();
        IERC20ReceiverToken asset = IERC20ReceiverToken(token);
        uint256 beforeBalance = asset.balanceOf(address(this));
        if (beforeBalance < amount) revert InsufficientFunding();
        IReceiverERC20Swap destination = IReceiverERC20Swap(swapContract);
        if (destination.swaps(swapKey)) revert ExistingLock();
        uint256 beforeLocked = asset.balanceOf(swapContract);
        activated = true;
        _tokenCall(token, abi.encodeCall(asset.approve, (swapContract, 0)));
        _tokenCall(token, abi.encodeCall(asset.approve, (swapContract, amount)));
        destination.lock(preimageHash, amount, token, claimAddress, refundAddress, timelock);
        _tokenCall(token, abi.encodeCall(asset.approve, (swapContract, 0)));
        if (
            !destination.swaps(swapKey) || asset.allowance(address(this), swapContract) != 0 ||
            asset.balanceOf(address(this)) != beforeBalance - amount ||
            asset.balanceOf(swapContract) != beforeLocked + amount
        ) revert UnexpectedTransfer();
        emit Activated(swapKey);
    }

    function recover(address recoveredToken) external guarded {
        if (recoveredToken.code.length == 0) revert InvalidBinding();
        IERC20ReceiverToken asset = IERC20ReceiverToken(recoveredToken);
        uint256 beforeBalance = asset.balanceOf(address(this));
        uint256 recoverable = beforeBalance;
        if (recoveredToken == token && !activated && block.number < activationCutoff && block.timestamp < activationCutoffTimestamp) {
            if (recoverable <= amount) revert NothingRecoverable();
            recoverable -= amount;
        }
        if (recoverable == 0) revert NothingRecoverable();
        uint256 beforeRefund = asset.balanceOf(refundAddress);
        _tokenCall(recoveredToken, abi.encodeCall(IERC20ReceiverToken.transfer, (refundAddress, recoverable)));
        if (
            asset.balanceOf(address(this)) != beforeBalance - recoverable ||
            asset.balanceOf(refundAddress) != beforeRefund + recoverable
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
