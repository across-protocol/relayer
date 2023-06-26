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
  },
};
