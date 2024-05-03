/// This file contains contracts that can be used to unit test the src/clients/bridges/op-stack
/// code which reads events from OpStack contracts facilitating cross chain transfers.

pragma solidity ^0.8.0;

contract OpStackWethBridge {
    event ETHDepositInitiated(address indexed _from, address indexed _to, uint256 _amount, bytes _data);
    event DepositFinalized(
        address indexed _l1Token,
        address indexed _l2Token,
        address indexed _from,
        address _to,
        uint256 _amount,
        bytes _data
    );

    function emitDepositInitiated(address from, address to, uint256 amount) external {
        emit ETHDepositInitiated(from, to, amount, new bytes(0));
    }

    function emitDepositFinalized(address from, address to, uint256 amount) external {
        emit DepositFinalized(address(0), address(0), from, to, amount, new bytes(0));
    }
}
