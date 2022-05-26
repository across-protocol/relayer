// Common
export const weth9Abi = [
  {
    constant: false,
    inputs: [{ name: "wad", type: "uint256" }],
    name: "withdraw",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    constant: false,
    inputs: [],
    name: "deposit",
    outputs: [],
    payable: true,
    stateMutability: "payable",
    type: "function",
  },
  {
    constant: true,
    inputs: [{ name: "", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
];

// Optimism
export const optimismL2BridgeInterface = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "_l1Token", type: "address" },
      { indexed: true, internalType: "address", name: "_l2Token", type: "address" },
      { indexed: true, internalType: "address", name: "_from", type: "address" },
      { indexed: false, internalType: "address", name: "_to", type: "address" },
      { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
      { indexed: false, internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "DepositFinalized",
    type: "event",
  },
];

export const optimismL1BridgeInterface = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "_l1Token", type: "address" },
      { indexed: true, internalType: "address", name: "_l2Token", type: "address" },
      { indexed: true, internalType: "address", name: "_from", type: "address" },
      { indexed: false, internalType: "address", name: "_to", type: "address" },
      { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
      { indexed: false, internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "ERC20DepositInitiated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "_from", type: "address" },
      { indexed: true, internalType: "address", name: "_to", type: "address" },
      { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
      { indexed: false, internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "ETHDepositInitiated",
    type: "event",
  },
  {
    inputs: [
      { internalType: "uint32", name: "_l2Gas", type: "uint32" },
      { internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "depositETH",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "_l1Token", type: "address" },
      { internalType: "address", name: "_l2Token", type: "address" },
      { internalType: "uint256", name: "_amount", type: "uint256" },
      { internalType: "uint32", name: "_l2Gas", type: "uint32" },
      { internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "depositERC20",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

// Arbitrum
export const arbitrumL2Erc20GatewayInterface = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "l1Token", type: "address" },
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "DepositFinalized",
    type: "event",
  },
];

export const arbitrumL1Erc20GatewayInterface = [
  {
    inputs: [
      { internalType: "address", name: "_token", type: "address" },
      { internalType: "address", name: "_to", type: "address" },
      { internalType: "uint256", name: "_amount", type: "uint256" },
      { internalType: "uint256", name: "_maxGas", type: "uint256" },
      { internalType: "uint256", name: "_gasPriceBid", type: "uint256" },
      { internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "outboundTransfer",
    outputs: [{ internalType: "bytes", name: "", type: "bytes" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "address", name: "l1Token", type: "address" },
      { indexed: true, internalType: "address", name: "_from", type: "address" },
      { indexed: true, internalType: "address", name: "_to", type: "address" },
      { indexed: true, internalType: "uint256", name: "_sequenceNumber", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
    ],
    name: "DepositInitiated",
    type: "event",
  },
];
