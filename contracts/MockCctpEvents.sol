pragma solidity ^0.8.0;

contract CctpTokenMessenger {
    event DepositForBurn(
        uint64 indexed nonce,
        address indexed burnToken,
        uint256 amount,
        address indexed depositor,
        bytes32 mintRecipient,
        uint32 destinationDomain,
        bytes32 destinationTokenMessenger,
        bytes32 destinationCaller
    );
    event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken);

    function emitDepositForBurn(
        uint64 nonce,
        address burnToken,
        uint256 amount,
        address depositor,
        bytes32 mintRecipient,
        uint32 destinationDomain,
        bytes32 destinationTokenMessenger,
        bytes32 destinationCaller
    ) external {
        emit DepositForBurn(
            nonce,
            burnToken,
            amount,
            depositor,
            mintRecipient,
            destinationDomain,
            destinationTokenMessenger,
            destinationCaller
        );
    }

    function emitMintAndWithdraw(address mintRecipient, uint256 amount, address mintToken) external {
        emit MintAndWithdraw(mintRecipient, amount, mintToken);
    }
}

contract CctpMessageTransmitter {
    mapping(bytes32 => uint256) public usedNonces;

    function setUsedNonce(bytes32 nonceHash, bool isUsed) external {
        usedNonces[nonceHash] = isUsed ? 1 : 0;
    }
}
