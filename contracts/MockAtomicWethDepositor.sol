// This file contains events to simulate the Atomic Depositor

pragma solidity ^0.8.0;

contract MockAtomicWethDepositor {
    event ZkSyncEthDepositInitiated(address indexed from, address indexed to, uint256 amount);

    function bridgeWethToZkSync(address to, uint256 amount, uint256, uint256, address) public {
        emit ZkSyncEthDepositInitiated(msg.sender, to, amount);
    }
}
