// This file contains contracts that can be used to unit test the src/clients/bridges/ZkSyncAdapter.ts
// code which reads events from zkSync contracts facilitating cross chain transfers.

pragma solidity ^0.8.0;

contract Polygon_L1Bridge {
    event LockedERC20(
        address indexed depositor,
        address indexed depositReceiver,
        address indexed rootToken,
        uint256 amount
    );

    event LockedEther(address indexed depositor, address indexed depositReceiver, uint256 amount);

    function depositFor(address depositor, address depositReceiver, address rootToken, uint256 amount) external {
        emit LockedERC20(depositor, depositReceiver, rootToken, amount);
    }

    function depositEtherFor(address depositor, address depositReceiver, uint256 amount) external {
        emit LockedEther(depositor, depositReceiver, amount);
    }
}

contract Polygon_L2Bridge {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function transfer(address from, address to, uint256 value) external {
        emit Transfer(from, to, value);
    }
}
