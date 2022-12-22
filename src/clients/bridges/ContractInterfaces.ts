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
export const ovmL1BridgeInterface = [
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

export const ovmL2BridgeInterface = [
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

// Arbitrum

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

// Optimism, Boba and polygon cant deposit WETH directly so we use an atomic depositor contract that unwraps WETH and
// bridges ETH other the canonical bridge.
export const atomicDepositorInterface = [
  { stateMutability: "payable", type: "fallback" },
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "uint32", name: "l2Gas", type: "uint32" },
      { internalType: "uint256", name: "chainId", type: "uint256" },
    ],
    name: "bridgeWethToOvm",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "bridgeWethToPolygon",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  { stateMutability: "payable", type: "receive" },
];
