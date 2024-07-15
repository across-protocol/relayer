/// This file contains contracts that can be used to unit test the src/clients/bridges/arbitrum
/// code which reads events from Arbitrum contracts facilitating cross chain transfers.

pragma solidity ^0.8.0;

contract ArbitrumERC20Bridge {
    event DepositInitiated(
        address l1Token,
        address indexed _from,
        address indexed _to,
        uint256 indexed _sequenceNumber,
        uint256 _amount
    );
    event DepositFinalized(address indexed l1Token, address indexed from, address indexed to, uint256 amount);

    function emitDepositInitiated(
        address l1Token,
        address from,
        address to,
        uint256 sequenceNumber,
        uint256 amount
    ) external {
        emit DepositInitiated(l1Token, from, to, sequenceNumber, amount);
    }

    function emitDepositFinalized(address l1Token, address from, address to, uint256 amount) external {
        emit DepositFinalized(l1Token, from, to, amount);
    }
}
