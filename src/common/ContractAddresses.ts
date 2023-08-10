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
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "address", type: "address" },
            { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
          ],
          name: "EthWithdrawalFinalized",
          type: "event",
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
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "to", type: "address" },
            { indexed: true, internalType: "address", name: "address", type: "address" },
            { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
          ],
          name: "WithdrawalFinalized",
          type: "event",
        },
        {
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "l2DepositHash", type: "address" },
            { indexed: true, internalType: "address", name: "from", type: "address" },
            { indexed: true, internalType: "address", name: "to", type: "address" },
            { indexed: false, internalType: "address", name: "l1Token", type: "address" },
            { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
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
      ],
    },
    // Optimism and Polygon cant deposit WETH directly so we use an atomic depositor contract that unwraps WETH and
    // bridges ETH other the canonical bridge.
    atomicDepositor: {
      address: "0x26eaf37ee5daf49174637bdcd2f7759a25206c34",
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
        { stateMutability: "payable", type: "receive" },
      ],
    },
    ovmStandardBridge: {
      address: "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1",
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
      ],
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
  },
  324: {
    zkSyncDefaultErc20Bridge: {
      address: "0x11f943b2c77b743AB90f4A0Ae7d5A4e7FCA3E102",
      abi: [
        {
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "l1Sender", type: "address" },
            { indexed: true, internalType: "address", name: "l2Receiver", type: "address" },
            { indexed: true, internalType: "address", name: "l2Token", type: "address" },
            { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
          ],
          name: "FinalizeDeposit",
          type: "event",
        },
        {
          anonymous: false,
          inputs: [
            { indexed: true, internalType: "address", name: "l2Sender", type: "address" },
            { indexed: true, internalType: "address", name: "l1Receiver", type: "address" },
            { indexed: true, internalType: "address", name: "l2Token", type: "address" },
            { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
          ],
          name: "WithdrawalInitiated",
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
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
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
    weth: {
      address: "0x4200000000000000000000000000000000000006",
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
    eth: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
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
  },
};
