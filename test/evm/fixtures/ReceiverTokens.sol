// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract ReceiverProbeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public mode;
    bool public reentryBlocked;

    function setMode(uint256 value) external { mode = value; }
    function mint(address account, uint256 amount) external { balanceOf[account] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        if (mode == 1) return false;
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address recipient, uint256 amount) external returns (bool) {
        if (mode == 4) return false;
        if (mode == 5) return true;
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool) {
        allowance[owner][msg.sender] -= amount;
        if (mode == 2) {
            (bool ok,) = owner.call(abi.encodeWithSignature("recover(address)", address(this)));
            reentryBlocked = !ok;
        }
        balanceOf[owner] -= amount;
        balanceOf[recipient] += mode == 3 ? amount - 1 : amount;
        return true;
    }
}

contract ReceiverNoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address account, uint256 amount) external { balanceOf[account] += amount; }
    function approve(address spender, uint256 amount) external { allowance[msg.sender][spender] = amount; }
    function transfer(address recipient, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
    }
    function transferFrom(address owner, address recipient, uint256 amount) external {
        allowance[owner][msg.sender] -= amount;
        balanceOf[owner] -= amount;
        balanceOf[recipient] += amount;
    }
}
