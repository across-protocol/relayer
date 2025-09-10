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

    event BridgehubDepositInitiated(
        uint256 indexed chainId,
        bytes32 indexed txDataHash,
        address indexed from,
        address to,
        address l1Token,
        uint256 amount
    );

    address l1USDC;

    function setUSDC(address l1Token) external {
        l1USDC = l1Token;
    }

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

    function _depositUSDCFor(
        address from,
        address to,
        address l1Token,
        uint256 amount,
        uint256 chainId
    ) internal returns (bytes32 txDataHash) {
        txDataHash = "";
        emit BridgehubDepositInitiated(chainId, txDataHash, from, to, l1Token, amount);
        return txDataHash;
    }

    function requestL2TransactionTwoBridges(
        L2TransactionRequestTwoBridgesOuter calldata _request
    ) external payable returns (bytes32 canonicalTxHash) {
        (address l1Token, uint256 amount, address to) = abi.decode(
            _request.secondBridgeCalldata,
            (address, uint256, address)
        );

        if (l1Token == l1USDC) {
            return _depositUSDCFor(msg.sender, to, l1Token, amount, _request.chainId);
        }

        return _depositFor(msg.sender, to, l1Token, amount, _request.chainId);
    }

    function assetId(address token) public view returns (bytes32) {
        return keccak256(abi.encodePacked(token));
    }
}

contract zkSync_L2Bridge {
    event BridgeMint(uint256 indexed chainId, bytes32 indexed assetId, address receiver, uint256 amount);

    event FinalizeDeposit(address indexed from, address indexed to, address indexed l2Token, uint256 amount);

    mapping(address => address) tokenMap;

    address l2USDC;

    function mapToken(address _l1Token, address _l2Token) external {
        tokenMap[_l1Token] = _l2Token;
    }

    function setUSDC(address l2Token) external {
        l2USDC = l2Token;
    }

    function finalizeDeposit(uint256 _chainId, address _l2Receiver, address _l1Token, uint256 _amount) external {
        address l2Token = tokenMap[_l1Token];
        if (l2Token == l2USDC) {
            emit FinalizeDeposit(_l2Receiver, _l2Receiver, l2Token, _amount);
        } else {
            emit BridgeMint(_chainId, assetId(l2Token), _l2Receiver, _amount);
        }
    }

    function assetId(address token) public view returns (bytes32) {
        return keccak256(abi.encodePacked(token));
    }
}
