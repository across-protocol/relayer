// This file contains contracts that can be used to unit test the src/clients/bridges/ZkSyncAdapter.ts
// code which reads events from zkSync contracts facilitating cross chain transfers.

pragma solidity ^0.8.0;

contract MockWETH9 {
    event Transfer(address indexed from, address indexed to, uint256 amount);

    function transfer(address from, address to, uint256 amount) external {
        emit Transfer(from, to, amount);
    }
}
