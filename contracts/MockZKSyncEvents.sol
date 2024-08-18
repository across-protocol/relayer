// This file contains contracts that can be used to unit test the src/clients/bridges/ZkSyncAdapter.ts
// code which reads events from zkSync contracts facilitating cross chain transfers.

pragma solidity ^0.8.0;

contract zkSync_L1Bridge {
    event DepositInitiated(
        bytes32 indexed l2DepositTxHash,
        address indexed from,
        address indexed to,
        address l1Token,
        uint256 amount
    );

    function deposit(
        address _l2Receiver,
        address _l1Token,
        uint256 _amount,
        uint256,
        uint256
    ) public payable returns (bytes32 l2TxHash) {
        return _depositFor(msg.sender, _l2Receiver, _l1Token, _amount);
    }

    function depositFor(
        address _l1Sender,
        address _l2Receiver,
        address _l1Token,
        uint256 _amount,
        uint256,
        uint256
    ) public payable returns (bytes32 l2TxHash) {
        return _depositFor(_l1Sender, _l2Receiver, _l1Token, _amount);
    }

    function _depositFor(
        address l1Sender,
        address l2Receiver,
        address l1Token,
        uint256 amount
    ) internal returns (bytes32 l2TxHash) {
        l2TxHash = "";
        emit DepositInitiated(l2TxHash, l1Sender, l2Receiver, l1Token, amount);
        return l2TxHash;
    }
}

contract zkSync_L2Bridge {
    event FinalizeDeposit(
        address indexed l1Sender,
        address indexed l2Receiver,
        address indexed l2Token,
        uint256 amount
    );

    mapping(address => address) tokenMap;

    function mapToken(address _l1Token, address _l2Token) external {
        tokenMap[_l1Token] = _l2Token;
    }

    function finalizeDeposit(address _l1Sender, address _l2Receiver, address _l1Token, uint256 _amount) external {
        address l2Token = tokenMap[_l1Token];
        emit FinalizeDeposit(_l1Sender, _l2Receiver, l2Token, _amount);
    }
}
