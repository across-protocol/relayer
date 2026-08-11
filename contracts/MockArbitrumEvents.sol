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

/// Gateway events on the withdrawal (L2 -> L1) leg. l1Token is non-indexed on both events, matching the
/// ArbitrumErc20Gateway ABIs the bridge adapter reads.
contract ArbitrumERC20Gateway {
    event WithdrawalInitiated(
        address l1Token,
        address indexed _from,
        address indexed _to,
        uint256 indexed _l2ToL1Id,
        uint256 _exitNum,
        uint256 _amount
    );
    event WithdrawalFinalized(
        address l1Token,
        address indexed _from,
        address indexed _to,
        uint256 indexed _exitNum,
        uint256 _amount
    );

    function emitWithdrawalInitiated(
        address l1Token,
        address from,
        address to,
        uint256 l2ToL1Id,
        uint256 exitNum,
        uint256 amount
    ) external {
        emit WithdrawalInitiated(l1Token, from, to, l2ToL1Id, exitNum, amount);
    }

    function emitWithdrawalFinalized(
        address l1Token,
        address from,
        address to,
        uint256 exitNum,
        uint256 amount
    ) external {
        emit WithdrawalFinalized(l1Token, from, to, exitNum, amount);
    }
}
