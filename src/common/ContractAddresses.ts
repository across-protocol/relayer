import { constants } from "@across-protocol/sdk-v2"
const { TOKEN_SYMBOLS_MAP } = constants;
// Constants file exporting hardcoded contract addresses per chain.
export const CONTRACT_ADDRESSES: {
  [chainId: number]: {
    [contractName: string]: {
      address: string;
      abi?: any[];
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
    },
    weth: {
      address: TOKEN_SYMBOLS_MAP.WETH.addresses[1],
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
    }
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
  },
};
