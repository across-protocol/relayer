// This file emulates a Scroll ERC20 Gateway. For testing, it is used as both the L1 and L2 bridge contract.

pragma solidity ^0.8.0;

contract ScrollBridge {
    event DepositERC20(
        address indexed l1Token,
        address indexed l2Token,
        address indexed from,
        address to,
        uint256 amount,
        bytes data
    );
    event FinalizeDepositERC20(
        address indexed l1Token,
        address indexed l2Token,
        address indexed from,
        address to,
        uint256 amount,
        bytes data
    );

    function deposit(address l1Token, address l2Token, address from, address to, uint256 amount) public {
        emit DepositERC20(l1Token, l2Token, from, to, amount, new bytes(0));
    }

    function finalize(address l1Token, address l2Token, address from, address to, uint256 amount) public {
        emit FinalizeDepositERC20(l1Token, l2Token, from, to, amount, new bytes(0));
    }
}
