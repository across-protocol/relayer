export const MESSAGE_TRANSMITTER_ABI = [
  {
    inputs: [
      {
        internalType: "bytes",
        name: "message",
        type: "bytes",
      },
      {
        internalType: "bytes",
        name: "attestation",
        type: "bytes",
      },
    ],
    name: "receiveMessage",
    outputs: [
      {
        internalType: "bool",
        name: "success",
        type: "bool",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "bytes32",
        name: "nonce",
        type: "bytes32",
      },
    ],
    name: "usedNonces",
    outputs: [
      {
        internalType: "bool",
        name: "",
        type: "bool",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
];

export const TOKEN_MESSENGER_ABI = [
  {
    inputs: [
      {
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
      {
        internalType: "uint32",
        name: "destinationDomain",
        type: "uint32",
      },
      {
        internalType: "bytes32",
        name: "mintRecipient",
        type: "bytes32",
      },
      {
        internalType: "address",
        name: "burnToken",
        type: "address",
      },
      {
        internalType: "bytes32",
        name: "destinationCaller",
        type: "bytes32",
      },
      {
        internalType: "uint256",
        name: "maxFee",
        type: "uint256",
      },
      {
        internalType: "uint32",
        name: "minFinalityThreshold",
        type: "uint32",
      },
    ],
    name: "depositForBurn",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];
