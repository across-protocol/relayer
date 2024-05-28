import { JsonFragment } from "@ethersproject/abi";

// ABI definition for CCTP contracts
const CCTP_MESSAGE_TRANSMITTER_CONTRACT_ABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: "bytes",
        name: "message",
        type: "bytes",
      },
    ],
    name: "MessageSent",
    type: "event",
  },
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
        name: "",
        type: "bytes32",
      },
    ],
    name: "usedNonces",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
];

export const CCTP_TOKEN_MESSENGER_CONTRACT_ABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "uint64",
        name: "nonce",
        type: "uint64",
      },
      {
        indexed: true,
        internalType: "address",
        name: "burnToken",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
      {
        indexed: true,
        internalType: "address",
        name: "depositor",
        type: "address",
      },
      {
        indexed: false,
        internalType: "bytes32",
        name: "mintRecipient",
        type: "bytes32",
      },
      {
        indexed: false,
        internalType: "uint32",
        name: "destinationDomain",
        type: "uint32",
      },
      {
        indexed: false,
        internalType: "bytes32",
        name: "destinationTokenMessenger",
        type: "bytes32",
      },
      {
        indexed: false,
        internalType: "bytes32",
        name: "destinationCaller",
        type: "bytes32",
      },
    ],
    name: "DepositForBurn",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "mintRecipient",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
      {
        indexed: true,
        internalType: "address",
        name: "mintToken",
        type: "address",
      },
    ],
    name: "MintAndWithdraw",
    type: "event",
  },
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
    ],
    name: "depositForBurn",
    outputs: [
      {
        internalType: "uint64",
        name: "_nonce",
        type: "uint64",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
];

export const LINEA_MESSAGE_SERVICE_CONTRACT_ABI: JsonFragment[] = [
  {
    inputs: [],
    name: "minimumFeeInWei",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "bytes32", name: "_messageHash", type: "bytes32" }],
    name: "MessageClaimed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: "_from",
        type: "address",
      },
      {
        indexed: true,
        name: "_to",
        type: "address",
      },
      {
        indexed: false,
        name: "_fee",
        type: "uint256",
      },
      {
        indexed: false,
        name: "_value",
        type: "uint256",
      },
      {
        indexed: false,
        name: "_nonce",
        type: "uint256",
      },
      {
        indexed: false,
        name: "_calldata",
        type: "bytes",
      },
      {
        indexed: true,
        name: "_messageHash",
        type: "bytes32",
      },
    ],
    name: "MessageSent",
    type: "event",
  },
];

export const LINEA_TOKEN_BRIDGE_CONTRACT_ABI: JsonFragment[] = [
  {
    inputs: [
      { internalType: "address", name: "_token", type: "address" },
      { internalType: "uint256", name: "_amount", type: "uint256" },
      { internalType: "address", name: "_recipient", type: "address" },
    ],
    name: "bridgeToken",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "sender",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "recipient",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        indexed: true,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
    ],
    name: "BridgingInitiated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "nativeToken",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "bridgedToken",
        type: "address",
      },
      {
        indexed: true,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "address",
        name: "recipient",
        type: "address",
      },
    ],
    name: "BridgingFinalized",
    type: "event",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "_nativeToken",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "_amount",
        type: "uint256",
      },
      {
        internalType: "address",
        name: "_recipient",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "_chainId",
        type: "uint256",
      },
      {
        internalType: "bytes",
        name: "_tokenMetadata",
        type: "bytes",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
    name: "completeBridging",
  },
];

export const LINEA_USDC_BRIDGE_CONTRACT_ABI: JsonFragment[] = [
  {
    inputs: [
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "address", name: "to", type: "address" },
    ],
    name: "depositTo",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "depositor",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
      {
        indexed: true,
        internalType: "address",
        name: "to",
        type: "address",
      },
    ],
    name: "Deposited",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "recipient",
        type: "address",
      },
      {
        indexed: true,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
    ],
    name: "ReceivedFromOtherLayer",
    type: "event",
  },
  {
    inputs: [
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "receiveFromOtherLayer",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

const OP_WETH_ABI = [
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
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "dst",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "wad",
        type: "uint256",
      },
    ],
    name: "Deposit",
    type: "event",
  },
];

const OP_STANDARD_BRIDGE_ABI = [
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

const OVM_STANDARD_BRIDGE_ABI: JsonFragment[] = [
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

// Constants file exporting hardcoded contract addresses per chain.
export const CONTRACT_ADDRESSES: {
  [chainId: number]: {
    [contractName: string]: {
      address?: string;
      abi?: unknown[];
    };
  };
} = {
  1: {
    lineaMessageService: {
      address: "0xd19d4B5d358258f05D7B411E21A1460D11B0876F",
      abi: LINEA_MESSAGE_SERVICE_CONTRACT_ABI,
    },
    lineaL1TokenBridge: {
      address: "0x051F1D88f0aF5763fB888eC4378b4D8B29ea3319",
      abi: LINEA_TOKEN_BRIDGE_CONTRACT_ABI,
    },
    lineaL1UsdcBridge: {
      address: "0x504A330327A089d8364C4ab3811Ee26976d388ce",
      abi: LINEA_USDC_BRIDGE_CONTRACT_ABI,
    },
    zkSyncMailbox: {
      address: "0x32400084C286CF3E17e7B677ea9583e60a000324",
      abi: [
        {
          inputs: [
            { internalType: "address", name: "_contractL2", type: "address" },
            { internalType: "uint256", name: "_l2Value", type: "uint256" },
            { internalType: "bytes", name: "_calldata", type: "bytes" },
            { internalType: "uint256", name: "_l2GasLimit", type: "uint256" },
            { internalType: "uint256", name: "_l2GasPerPubdataByteLimit", type: "uint256" },
            { internalType: "bytes[]", name: "_factoryDeps", type: "bytes[]" },
            { internalType: "address", name: "_refundRecipient", type: "address" },
          ],
          name: "requestL2Transaction",
          outputs: [{ internalType: "bytes32", name: "canonicalTxHash", type: "bytes32" }],
          stateMutability: "payable",
          type: "function",
        },
        {
          inputs: [
            { internalType: "uint256", name: "_gasPrice", type: "uint256" },
            { internalType: "uint256", name: "_l2GasLimit", type: "uint256" },
            { internalType: "uint256", name: "_l2GasPerPubdataByteLimit", type: "uint256" },
          ],
          name: "l2TransactionBaseCost",
          outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
          stateMutability: "pure",
          type: "function",
        },
        {
          inputs: [
            { internalType: "uint256", name: "_l2BlockNumber", type: "uint256" },
            { internalType: "uint256", name: "_l2MessageIndex", type: "uint256" },
            { internalType: "uint16", name: "_l2TxNumberInBlock", type: "uint16" },
            { internalType: "bytes", name: "_message", type: "bytes" },
            { internalType: "bytes32[]", name: "_merkleProof", type: "bytes32[]" },
          ],
          name: "finalizeEthWithdrawal",
          outputs: [],
          stateMutability: "nonpayable",
          type: "function",
        },
        {
          inputs: [
            { internalType: "uint256", name: "_l2BlockNumber", type: "uint256" },
            { internalType: "uint256", name: "_l2MessageIndex", type: "uint256" },
          ],
          name: "isEthWithdrawalFinalized",
          outputs: [{ internalType: "bool", name: "", type: "bool" }],
          stateMutability: "view",
          type: "function",
        },
      ],
    },
    zkSyncDefaultErc20Bridge: {
      address: "0x57891966931Eb4Bb6FB81430E6cE0A03AAbDe063",
      abi: [
        {
          inputs: [
            { internalType: "address", name: "_l2Receiver", type: "address" },
            { internalType: "address", name: "_l1Token", type: "address" },
            { internalType: "uint256", name: "_amount", type: "uint256" },
            { internalType: "uint256", name: "_l2TxGasLimit", type: "uint256" },
            { internalType: "uint256", name: "_l2TxGasPerPubdataByte", type: "uint256" },
          ],
          name: "deposit",
          outputs: [{ internalType: "bytes32", name: "l2TxHash", type: "bytes32" }],
          stateMutability: "payable",
          type: "function",
        },
        {
          inputs: [
            { internalType: "uint256", name: "_l2BlockNumber", type: "uint256" },
            { internalType: "uint256", name: "_l2MessageIndex", type: "uint256" },
            { internalType: "uint16", name: "_l2TxNumberInBlock", type: "uint16" },
            { internalType: "bytes", name: "_message", type: "bytes" },
            { internalType: "bytes32[]", name: "_merkleProof", type: "bytes32[]" },
          ],
          name: "finalizeWithdrawal",
          outputs: [],
          stateMutability: "nonpayable",
          type: "function",
        },
        {
          inputs: [
            { internalType: "uint256", name: "_l2BlockNumber", type: "uint256" },
            { internalType: "uint256", name: "_l2MessageIndex", type: "uint256" },
          ],
          name: "isWithdrawalFinalized",
          outputs: [{ internalType: "bool", name: "", type: "bool" }],
          stateMutability: "view",
          type: "function",
        },
        {
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "bytes32", name: "l2DepositHash", type: "bytes32" },
            { indexed: true, internalType: "address", name: "from", type: "address" },
            { indexed: true, internalType: "address", name: "_to", type: "address" },
            { indexed: false, internalType: "address", name: "l1Token", type: "address" },
            { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
          ],
          name: "DepositInitiated",
          type: "event",
        },
      ],
    },
    daiOptimismBridge: {
      address: "0x10e6593cdda8c58a1d0f14c5164b376352a55f2f",
      abi: [
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
      ],
    },
    snxOptimismBridge: {
      address: "0x39Ea01a0298C315d149a490E34B59Dbf2EC7e48F",
      abi: [
        {
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "_from", type: "address" },
            { indexed: true, internalType: "address", name: "_to", type: "address" },
            { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
          ],
          name: "DepositInitiated",
          type: "event",
        },
        {
          inputs: [
            { internalType: "address", name: "to", type: "address" },
            { internalType: "uint256", name: "amount", type: "uint256" },
          ],
          name: "depositTo",
          outputs: [],
          stateMutability: "nonpayable",
          type: "function",
        },
      ],
    },
    // OVM, ZkSync, Linea, and Polygon cant deposit WETH directly so we use an atomic depositor contract that unwraps WETH and
    // bridges ETH other the canonical bridge.
    atomicDepositor: {
      address: "0x24d8b91aB9c461d7c0D6fB9F5a294CEA61D11710",
      abi: [
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
        {
          inputs: [
            { internalType: "address", name: "to", type: "address" },
            { internalType: "uint256", name: "amount", type: "uint256" },
          ],
          name: "bridgeWethToLinea",
          outputs: [],
          stateMutability: "payable",
          type: "function",
        },
        {
          inputs: [
            { internalType: "address", name: "to", type: "address" },
            { internalType: "uint256", name: "amount", type: "uint256" },
            { internalType: "uint256", name: "l2GasLimit", type: "uint256" },
            { internalType: "uint256", name: "l2GasPerPubdataByteLimit", type: "uint256" },
            { internalType: "address", name: "refundRecipient", type: "address" },
          ],
          name: "bridgeWethToZkSync",
          outputs: [],
          stateMutability: "nonpayable",
          type: "function",
        },
        {
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "from", type: "address" },
            { indexed: true, internalType: "address", name: "_to", type: "address" },
            { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
          ],
          name: "ZkSyncEthDepositInitiated",
          type: "event",
        },
        {
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "from", type: "address" },
            { indexed: true, internalType: "address", name: "_to", type: "address" },
            { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
          ],
          name: "LineaEthDepositInitiated",
          type: "event",
        },
        { stateMutability: "payable", type: "receive" },
      ],
    },
    // Since there are multiple ovmStandardBridges on mainnet for different OP Stack chains, we append the chain id of the Op
    // Stack chain to the name to differentiate. This one is for Optimism.
    ovmStandardBridge_10: {
      address: "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1",
      abi: OVM_STANDARD_BRIDGE_ABI,
    },
    // Since there are multiple ovmStandardBridges on mainnet for different OP Stack chains, we append the chain id of the Op
    // Stack chain to the name to differentiate. This one is for Base.
    ovmStandardBridge_8453: {
      address: "0x3154Cf16ccdb4C6d922629664174b904d80F2C35",
      abi: OVM_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_34443: {
      address: "0x735aDBbE72226BD52e818E7181953f42E3b0FF21",
      abi: OVM_STANDARD_BRIDGE_ABI,
    },
    polygonRootChainManager: {
      address: "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77",
      abi: [
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
      ],
    },
    polygonBridge: {
      abi: [
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
      ],
    },
    arbitrumErc20GatewayRouter: {
      address: "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef",
      abi: [
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
      ],
    },
    weth: {
      abi: [
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
      ],
    },
    VotingV2: {
      address: "0x004395edb43EFca9885CEdad51EC9fAf93Bd34ac",
      abi: [
        {
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "requester", type: "address" },
            { indexed: true, internalType: "uint32", name: "roundId", type: "uint32" },
            { indexed: true, internalType: "bytes32", name: "identifier", type: "bytes32" },
            { indexed: false, internalType: "uint256", name: "time", type: "uint256" },
            { indexed: false, internalType: "bytes", name: "ancillaryData", type: "bytes" },
            { indexed: false, internalType: "bool", name: "isGovernance", type: "bool" },
          ],
          name: "RequestAdded",
          type: "event",
        },
      ],
    },
    cctpMessageTransmitter: {
      address: "0x0a992d191deec32afe36203ad87d7d289a738f81",
      abi: CCTP_MESSAGE_TRANSMITTER_CONTRACT_ABI,
    },
    cctpTokenMessenger: {
      address: "0xbd3fa81b58ba92a82136038b25adec7066af3155",
      abi: CCTP_TOKEN_MESSENGER_CONTRACT_ABI,
    },
    scrollRelayMessenger: {
      address: "0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367",
      abi: [
        {
          inputs: [
            {
              internalType: "address",
              name: "_from",
              type: "address",
            },
            {
              internalType: "address",
              name: "_to",
              type: "address",
            },
            {
              internalType: "uint256",
              name: "_value",
              type: "uint256",
            },
            {
              internalType: "uint256",
              name: "_nonce",
              type: "uint256",
            },
            {
              internalType: "bytes",
              name: "_message",
              type: "bytes",
            },
            {
              components: [
                {
                  internalType: "uint256",
                  name: "batchIndex",
                  type: "uint256",
                },
                {
                  internalType: "bytes",
                  name: "merkleProof",
                  type: "bytes",
                },
              ],
              internalType: "struct IL1ScrollMessenger.L2MessageProof",
              name: "_proof",
              type: "tuple",
            },
          ],
          name: "relayMessageWithProof",
          outputs: [],
          stateMutability: "nonpayable",
          type: "function",
        },
      ],
    },
    hubPool: {
      address: "0xc186fA914353c44b2E33eBE05f21846F1048bEda",
      abi: [
        {
          anonymous: false,
          inputs: [
            { indexed: false, internalType: "address", name: "l1Token", type: "address" },
            { indexed: false, internalType: "address", name: "l2Token", type: "address" },
            { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
            { indexed: false, internalType: "address", name: "to", type: "address" },
          ],
          name: "TokensRelayed",
          type: "event",
        },
      ],
    },
  },
  10: {
    daiOptimismBridge: {
      address: "0x467194771dae2967aef3ecbedd3bf9a310c76c65",
      abi: [
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
      ],
    },
    snxOptimismBridge: {
      address: "0x136b1EC699c62b0606854056f02dC7Bb80482d63",
      abi: [
        {
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "_to", type: "address" },
            { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
          ],
          name: "DepositFinalized",
          type: "event",
        },
      ],
    },
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OP_STANDARD_BRIDGE_ABI,
    },
    weth: {
      address: "0x4200000000000000000000000000000000000006",
      abi: OP_WETH_ABI,
    },
    eth: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
    cctpMessageTransmitter: {
      address: "0x4d41f22c5a0e5c74090899e5a8fb597a8842b3e8",
      abi: CCTP_MESSAGE_TRANSMITTER_CONTRACT_ABI,
    },
    cctpTokenMessenger: {
      address: "0x2B4069517957735bE00ceE0fadAE88a26365528f",
      abi: CCTP_TOKEN_MESSENGER_CONTRACT_ABI,
    },
  },
  137: {
    withdrawableErc20: {
      abi: [
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
      ],
    },
    cctpMessageTransmitter: {
      address: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9",
      abi: CCTP_MESSAGE_TRANSMITTER_CONTRACT_ABI,
    },
    cctpTokenMessenger: {
      address: "0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE",
      abi: CCTP_TOKEN_MESSENGER_CONTRACT_ABI,
    },
  },
  324: {
    zkSyncDefaultErc20Bridge: {
      address: "0x11f943b2c77b743AB90f4A0Ae7d5A4e7FCA3E102",
      abi: [
        {
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "l1Sender", type: "address" },
            { indexed: true, internalType: "address", name: "_to", type: "address" },
            { indexed: true, internalType: "address", name: "l2Token", type: "address" },
            { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
          ],
          name: "FinalizeDeposit",
          type: "event",
        },
      ],
    },
    eth: {
      address: "0x000000000000000000000000000000000000800A",
      abi: [
        {
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "from", type: "address" },
            { indexed: true, internalType: "address", name: "_to", type: "address" },
            { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
          ],
          name: "Transfer",
          type: "event",
        },
      ],
    },
    weth: {
      address: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91",
      abi: [
        {
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "from", type: "address" },
            { indexed: true, internalType: "address", name: "_to", type: "address" },
            { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
          ],
          name: "Transfer",
          type: "event",
        },
      ],
    },
  },
  8453: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OP_STANDARD_BRIDGE_ABI,
    },
    weth: {
      address: "0x4200000000000000000000000000000000000006",
      abi: OP_WETH_ABI,
    },
    eth: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
    cctpMessageTransmitter: {
      address: "0xAD09780d193884d503182aD4588450C416D6F9D4",
      abi: CCTP_MESSAGE_TRANSMITTER_CONTRACT_ABI,
    },
    cctpTokenMessenger: {
      address: "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962",
      abi: CCTP_TOKEN_MESSENGER_CONTRACT_ABI,
    },
  },
  34443: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OP_STANDARD_BRIDGE_ABI,
    },
    weth: {
      address: "0x4200000000000000000000000000000000000006",
      abi: OP_WETH_ABI,
    },
    eth: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
  },
  42161: {
    erc20Gateway: {
      abi: [
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
      ],
    },
    weth: {
      address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      abi: [
        {
          constant: false,
          inputs: [],
          name: "deposit",
          outputs: [],
          payable: true,
          stateMutability: "payable",
          type: "function",
        },
      ],
    },
    outbox: {
      address: "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840",
      abi: [
        {
          inputs: [
            { internalType: "bytes32[]", name: "proof", type: "bytes32[]" },
            { internalType: "uint256", name: "index", type: "uint256" },
            { internalType: "address", name: "l2Sender", type: "address" },
            { internalType: "address", name: "to", type: "address" },
            { internalType: "uint256", name: "l2Block", type: "uint256" },
            { internalType: "uint256", name: "l1Block", type: "uint256" },
            { internalType: "uint256", name: "l2Timestamp", type: "uint256" },
            { internalType: "uint256", name: "value", type: "uint256" },
            { internalType: "bytes", name: "data", type: "bytes" },
          ],
          name: "executeTransaction",
          outputs: [],
          stateMutability: "nonpayable",
          type: "function",
        },
      ],
    },
    cctpMessageTransmitter: {
      address: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca",
      abi: CCTP_MESSAGE_TRANSMITTER_CONTRACT_ABI,
    },
    cctpTokenMessenger: {
      address: "0x19330d10D9Cc8751218eaf51E8885D058642E08A",
      abi: CCTP_TOKEN_MESSENGER_CONTRACT_ABI,
    },
  },
  59144: {
    l2MessageService: {
      address: "0x508Ca82Df566dCD1B0DE8296e70a96332cD644ec",
      abi: LINEA_MESSAGE_SERVICE_CONTRACT_ABI,
    },
    lineaL2UsdcBridge: {
      address: "0xA2Ee6Fce4ACB62D95448729cDb781e3BEb62504A",
      abi: LINEA_USDC_BRIDGE_CONTRACT_ABI,
    },
    lineaL2TokenBridge: {
      address: "0x353012dc4a9A6cF55c941bADC267f82004A8ceB9",
      abi: LINEA_TOKEN_BRIDGE_CONTRACT_ABI,
    },
    weth: {
      address: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f",
      abi: [
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
          constant: false,
          inputs: [
            {
              name: "wad",
              type: "uint256",
            },
          ],
          name: "withdraw",
          outputs: [],
          payable: false,
          stateMutability: "nonpayable",
          type: "function",
        },
        {
          constant: true,
          inputs: [
            {
              name: "",
              type: "address",
            },
          ],
          name: "balanceOf",
          outputs: [
            {
              name: "",
              type: "uint256",
            },
          ],
          payable: false,
          stateMutability: "view",
          type: "function",
        },
      ],
    },
    eth: {
      address: "0x0000000000000000000000000000000000000000",
    },
  },
  // Testnets
  11155111: {
    cctpMessageTransmitter: {
      address: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
      abi: CCTP_MESSAGE_TRANSMITTER_CONTRACT_ABI,
    },
    cctpTokenMessenger: {
      address: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      abi: CCTP_TOKEN_MESSENGER_CONTRACT_ABI,
    },
  },
  84532: {
    cctpMessageTransmitter: {
      address: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
      abi: CCTP_MESSAGE_TRANSMITTER_CONTRACT_ABI,
    },
    cctpTokenMessenger: {
      address: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      abi: CCTP_TOKEN_MESSENGER_CONTRACT_ABI,
    },
  },
  59140: {
    l2MessageService: {
      address: "0xC499a572640B64eA1C8c194c43Bc3E19940719dC",
      abi: LINEA_MESSAGE_SERVICE_CONTRACT_ABI,
    },
  },
};
