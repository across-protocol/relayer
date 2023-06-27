// Polygon
export const polygonL1BridgeInterface = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "depositor", type: "address" },
      { indexed: true, internalType: "address", name: "depositReceiver", type: "address" },
      { indexed: true, internalType: "address", name: "rootToken", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "LockedERC20",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "depositor", type: "address" },
      { indexed: true, internalType: "address", name: "depositReceiver", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "LockedEther",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: true, internalType: "address", name: "token", type: "address" },
      { indexed: false, internalType: "uint256", name: "amountOrNFTId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "depositBlockId", type: "uint256" },
    ],
    name: "NewDepositBlock",
    type: "event",
  },
];

export const polygonL1RootChainManagerInterface = [
  {
    inputs: [
      { internalType: "address", name: "user", type: "address" },
      { internalType: "address", name: "rootToken", type: "address" },
      { internalType: "bytes", name: "depositData", type: "bytes" },
    ],
    name: "depositFor",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "user", type: "address" }],
    name: "depositEtherFor",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
];

export const polygonL2BridgeInterface = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: false, internalType: "uint256", name: "value", type: "uint256" },
    ],
    name: "Transfer",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "rootToken", type: "address" },
      { indexed: true, internalType: "address", name: "childToken", type: "address" },
      { indexed: true, internalType: "address", name: "user", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "depositCount", type: "uint256" },
    ],
    name: "TokenDeposited",
    type: "event",
  },
];
