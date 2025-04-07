// This file contains contracts that can be used to unit test the src/clients/bridges/ZkSyncAdapter.ts
// code which reads events from zkSync contracts facilitating cross chain transfers.

pragma solidity ^0.8.0;

contract zkSync_L1Bridge {
    event BridgeBurn(
        uint256 indexed chainId,
        bytes32 indexed assetId,
        address indexed sender,
        address receiver,
        uint256 amount
    );

    struct L2TransactionRequestTwoBridgesOuter {
        uint256 chainId;
        uint256 mintValue;
        uint256 l2Value;
        uint256 l2GasLimit;
        uint256 l2GasPerPubdataByteLimit;
        address refundRecipient;
        address secondBridgeAddress;
        uint256 secondBridgeValue;
        bytes secondBridgeCalldata;
    }

    function deposit(
        address _l2Receiver,
        address _l1Token,
        uint256 _amount,
        uint256,
        uint256
    ) public payable returns (bytes32 l2TxHash) {
        return _depositFor(msg.sender, _l2Receiver, _l1Token, _amount, 324);
    }

    function depositFor(
        address _l1Sender,
        address _l2Receiver,
        address _l1Token,
        uint256 _amount,
        uint256,
        uint256
    ) public payable returns (bytes32 l2TxHash) {
        return _depositFor(_l1Sender, _l2Receiver, _l1Token, _amount, 324);
    }

    function _depositFor(
        address l1Sender,
        address l2Receiver,
        address l1Token,
        uint256 amount,
        uint256 chainId
    ) internal returns (bytes32 l2TxHash) {
        l2TxHash = "";
        emit BridgeBurn(chainId, assetId(l1Token), l1Sender, l2Receiver, amount);
        return l2TxHash;
    }

    function requestL2TransactionTwoBridges(
        L2TransactionRequestTwoBridgesOuter calldata _request
    ) external payable returns (bytes32 canonicalTxHash) {
        (address l1Token, uint256 amount, address to) = abi.decode(
            _request.secondBridgeCalldata,
            (address, uint256, address)
        );
        _depositFor(msg.sender, to, l1Token, amount, _request.chainId);
        return "";
    }

    function assetId(address token) public view returns (bytes32) {
        return keccak256(abi.encodePacked(token));
    }
}

contract zkSync_L2Bridge {
    event BridgeMint(uint256 indexed chainId, bytes32 indexed assetId, address receiver, uint256 amount);

    mapping(address => address) tokenMap;

    function mapToken(address _l1Token, address _l2Token) external {
        tokenMap[_l1Token] = _l2Token;
    }

    function finalizeDeposit(uint256 _chainId, address _l2Receiver, address _l1Token, uint256 _amount) external {
        address l2Token = tokenMap[_l1Token];
        emit BridgeMint(_chainId, assetId(l2Token), _l2Receiver, _amount);
    }

    function assetId(address token) public view returns (bytes32) {
        return keccak256(abi.encodePacked(token));
    }
}
