// This file contains events to simulate the Atomic Depositor

pragma solidity ^0.8.0;

contract MockAtomicWethDepositor {
    event AtomicWethDepositInitiated(address indexed from, uint256 indexed chainId, uint256 amount);

    function bridgeWeth(uint256 chainId, uint256 amount, bytes calldata) public {
        emit AtomicWethDepositInitiated(msg.sender, chainId, amount);
    }
}
