/// This file contains contracts that can be used to unit test the src/clients/bridges/LineaAdapter.ts
/// code which reads events from Linea contracts facilitating cross chain transfers.

pragma solidity ^0.8.0;

contract LineaWethBridge {
    event MessageClaimed(bytes32 indexed _messageHash);
    event MessageSent(
        address indexed _from,
        address indexed _to,
        uint256 _fee,
        uint256 _value,
        uint256 _nonce,
        bytes _calldata,
        bytes32 indexed _messageHash
    );

    function emitMessageSent(address from, address to, uint256 value) external {
        emit MessageSent(from, to, 0, value, 0, new bytes(0), bytes32(0));
    }

    function emitMessageSentWithMessageHash(address from, address to, uint256 value, bytes32 messageHash) external {
        emit MessageSent(from, to, 0, value, 0, new bytes(0), messageHash);
    }

    function emitMessageClaimed(bytes32 messageHash) external {
        emit MessageClaimed(messageHash);
    }
}

contract LineaUsdcBridge {
    event Deposited(address indexed depositor, uint256 amount, address indexed to);
    event ReceivedFromOtherLayer(address indexed recipient, uint256 amount);

    function emitDeposited(address depositor, address to) external {
        emit Deposited(depositor, 0, to);
    }

    function emitReceivedFromOtherLayer(address recipient) external {
        emit ReceivedFromOtherLayer(recipient, 0);
    }
}

contract LineaERC20Bridge {
    event BridgingInitiatedV2(address indexed sender, address indexed recipient, address indexed token, uint256 amount);
    event BridgingFinalizedV2(
        address indexed nativeToken,
        address indexed bridgedToken,
        uint256 amount,
        address indexed recipient
    );

    function emitBridgingInitiated(address sender, address recipient, address token) external {
        emit BridgingInitiatedV2(sender, recipient, token, 0);
    }

    function emitBridgingFinalized(address l1Token, address recipient) external {
        emit BridgingFinalizedV2(l1Token, address(0), 0, recipient);
    }
}
