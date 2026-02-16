import { Account, Address, Chain, defineChain, PublicClient, TransactionReceipt, Transport, zeroAddress } from "viem";
import { readContract } from "viem/actions";
import { decodeAbiParameters } from "viem/utils";
import {
  chainConfig,
  getL2Output as viemGetL2Output,
  getWithdrawals,
  getWithdrawalStatus as viemGetWithdrawalStatus,
  buildProveWithdrawal as viemBuildProveWithdrawal,
} from "viem/op-stack";
import { typeguards } from "@across-protocol/sdk";
import { CHAIN_IDs, isDefined } from "../../../utils";

export const megaeth = defineChain({
  id: CHAIN_IDs.MEGAETH,
  name: "MegaETH",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.megaeth.io"] },
  },
  blockExplorers: {
    default: { name: "MegaETH Explorer", url: "https://explorer.megaeth.io" },
  },
  contracts: {
    ...chainConfig.contracts,
    portal: {
      [CHAIN_IDs.MAINNET]: {
        address: "0x7f82f57F0Dd546519324392e408b01fcC7D709e8",
      },
    },
    disputeGameFactory: {
      [CHAIN_IDs.MAINNET]: {
        address: "0x8546840adF796875cD9AAcc5B3B048f6B2c9D563",
      },
    },
    l2OutputOracle: {
      [CHAIN_IDs.MAINNET]: {
        address: zeroAddress,
      },
    },
  },
  sourceId: 1,
});

/**
 * MegaETH-specific viem actions for withdrawal finalization.
 * MegaETH uses a custom 24-byte extraData format instead of the standard 32-byte uint256.
 */
const gameCountAbi = [
  {
    type: "function",
    name: "gameCount",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const respectedGameTypeAbi = [
  {
    type: "function",
    name: "respectedGameType",
    inputs: [],
    outputs: [{ type: "uint32" }],
    stateMutability: "view",
  },
] as const;

const findLatestGamesAbi = [
  {
    type: "function",
    name: "findLatestGames",
    inputs: [
      { name: "_gameType", type: "uint32" },
      { name: "_start", type: "uint256" },
      { name: "_n", type: "uint256" },
    ],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "index", type: "uint256" },
          { name: "metadata", type: "bytes32" },
          { name: "timestamp", type: "uint64" },
          { name: "rootClaim", type: "bytes32" },
          { name: "extraData", type: "bytes" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

const finalizedWithdrawalsAbi = [
  {
    type: "function",
    name: "finalizedWithdrawals",
    inputs: [{ name: "withdrawalHash", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

const numProofSubmittersAbi = [
  {
    type: "function",
    name: "numProofSubmitters",
    inputs: [{ name: "withdrawalHash", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const proofSubmittersAbi = [
  {
    type: "function",
    name: "proofSubmitters",
    inputs: [
      { name: "withdrawalHash", type: "bytes32" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

const provenWithdrawalsAbi = [
  {
    type: "function",
    name: "provenWithdrawals",
    inputs: [
      { name: "withdrawalHash", type: "bytes32" },
      { name: "proofSubmitter", type: "address" },
    ],
    outputs: [
      { name: "disputeGameProxy", type: "address" },
      { name: "timestamp", type: "uint64" },
    ],
    stateMutability: "view",
  },
] as const;

const checkWithdrawalAbi = [
  {
    type: "function",
    name: "checkWithdrawal",
    inputs: [
      { name: "withdrawalHash", type: "bytes32" },
      { name: "proofSubmitter", type: "address" },
    ],
    outputs: [],
    stateMutability: "view",
  },
] as const;

/**
 * Decode MegaETH's custom 24-byte extraData format.
 * Format: [uint64 l2BlockNumber, uint64 parentGameIndex, uint64 duplicationCounter]
 */
function decodeMegaETHExtraData(extraData: `0x${string}`, debug = false): bigint {
  const data = extraData.slice(2); // Remove 0x prefix

  if (debug) {
    // console.log("=== MegaETH ExtraData Format ===");
    // console.log(`Raw: ${extraData}`);
    // console.log(`Length: ${data.length / 2} bytes (${data.length} hex chars)`);
  }

  if (data.length === 0) {
    return 0n;
  }

  // For 24-byte format, extract first 8 bytes as uint64
  if (data.length === 48) {
    // 24 bytes = 48 hex chars
    // Format: [8 bytes l2BlockNumber][8 bytes parentGameIndex][8 bytes duplicationCounter]
    // See extraData definition:
    // https://github.com/boundless-xyz/kailua/blob/4b315c5b10d61f28aeb1fc5a30e58a3cefb8de02/crates/contracts/foundry/src/KailuaGame.sol#L83
    const l2BlockNumberHex = data.slice(0, 16); // First 8 bytes = 16 hex chars
    // const parentGameIndexHex = data.slice(16, 32); // Next 8 bytes = 16 hex chars
    // const duplicationCounterHex = data.slice(32, 48); // Last 8 bytes = 16 hex chars

    const l2BlockNumber = BigInt("0x" + l2BlockNumberHex);

    if (debug) {
      // console.log("Format: 24-byte (MegaETH custom)");
      // console.log(`  L2 Block Number (uint64):      0x${l2BlockNumberHex} = ${l2BlockNumber}`);
      // console.log(`  Parent Game Index (uint64):    0x${parentGameIndexHex} = ${BigInt("0x" + parentGameIndexHex)}`);
      // console.log(
      //   `  Duplication Counter (uint64):  0x${duplicationCounterHex} = ${BigInt("0x" + duplicationCounterHex)}`
      // );
      // console.log("================================");
    }

    return l2BlockNumber;
  }

  // For standard 32-byte format, decode as uint256
  if (data.length === 64) {
    const [blockNumber] = decodeAbiParameters([{ type: "uint256" }], extraData);

    if (debug) {
      // console.log("Format: 32-byte (standard uint256)");
      // console.log(`  Block Number: ${blockNumber}`);
      // console.log("================================");
    }

    return blockNumber;
  }

  // Fallback: try to decode as uint256 anyway
  try {
    const [blockNumber] = decodeAbiParameters([{ type: "uint256" }], extraData);

    if (debug) {
      // console.log("Format: Non-standard, decoded as uint256");
      // console.log(`  Block Number: ${blockNumber}`);
      // console.log("================================");
    }

    return blockNumber;
  } catch {
    // If decoding fails, pad to 32 bytes and try again
    const paddedData: `0x${string}` = `0x${data.padEnd(64, "0")}`;
    const [blockNumber] = decodeAbiParameters([{ type: "uint256" }], paddedData);

    if (debug) {
      // console.log("Format: Non-standard, padded to 32 bytes");
      // console.log(`  Original: ${extraData}`);
      // console.log(`  Padded:   ${paddedData}`);
      // console.log(`  Block Number: ${blockNumber}`);
      // console.log("================================");
    }

    return blockNumber;
  }
}

/**
 * Get dispute games for MegaETH with custom extraData handling.
 * This is a modified version of viem's getGames that handles MegaETH's 24-byte extraData.
 */
export async function getMegaETHGames(
  client: any,
  parameters: {
    chain?: Chain;
    l2BlockNumber?: bigint;
    limit?: number;
    targetChain: {
      contracts: {
        portal: { [sourceId: number]: { address: Address } };
        disputeGameFactory: { [sourceId: number]: { address: Address } };
      };
    };
    portalAddress?: Address;
    disputeGameFactoryAddress?: Address;
  }
) {
  const { chain = client.chain, l2BlockNumber, limit = 100, targetChain } = parameters;

  const portalAddress = (() => {
    if (parameters.portalAddress) {
      return parameters.portalAddress;
    }
    if (chain) {
      return targetChain.contracts.portal[chain.id].address;
    }
    return Object.values(targetChain.contracts.portal)[0].address;
  })();

  const disputeGameFactoryAddress = (() => {
    if (parameters.disputeGameFactoryAddress) {
      return parameters.disputeGameFactoryAddress;
    }
    if (chain) {
      return targetChain.contracts.disputeGameFactory[chain.id].address;
    }
    return Object.values(targetChain.contracts.disputeGameFactory)[0].address;
  })();

  // Get game count and game type
  const [gameCount, gameType] = await Promise.all([
    // @ts-expect-error - viem 2.37 types require authorizationList but it's not actually needed for view functions
    readContract(client, {
      abi: gameCountAbi,
      functionName: "gameCount",
      args: [],
      address: disputeGameFactoryAddress,
    }),
    // @ts-expect-error - viem 2.37 types require authorizationList but it's not actually needed for view functions
    readContract(client, {
      abi: respectedGameTypeAbi,
      functionName: "respectedGameType",
      address: portalAddress,
    }),
  ]);

  // Get latest games
  // @ts-expect-error - viem 2.37 types require authorizationList but it's not actually needed for view functions
  const gamesResult = await readContract(client, {
    abi: findLatestGamesAbi,
    functionName: "findLatestGames",
    address: disputeGameFactoryAddress,
    args: [gameType, BigInt(Math.max(0, Number(gameCount - 1n))), BigInt(Math.min(limit, Number(gameCount)))],
  });

  // Process games with custom extraData decoding
  let firstGame = true;
  const games = gamesResult
    .map((game) => {
      try {
        // Use MegaETH-specific decoding (log first game to show format)
        const blockNumber = decodeMegaETHExtraData(game.extraData, firstGame);
        firstGame = false;
        return !l2BlockNumber || blockNumber > l2BlockNumber ? { ...game, l2BlockNumber: blockNumber } : null;
      } catch (error) {
        // Skip games we can't decode
        return null;
      }
    })
    .filter(isDefined);

  return games;
}

/**
 * Get withdrawal status for MegaETH with custom game handling.
 * This properly checks the OptimismPortal contract state instead of relying on dispute games.
 */
export async function getWithdrawalStatus(
  client: any,
  parameters: {
    receipt: TransactionReceipt;
    chain: Chain;
    targetChain: {
      contracts: {
        portal: { [sourceId: number]: { address: Address } };
        l2OutputOracle: { [sourceId: number]: { address: Address } };
        disputeGameFactory: { [sourceId: number]: { address: Address } };
      };
    };
    logIndex?: number;
  }
): Promise<"ready-to-prove" | "ready-to-finalize" | "waiting-to-finalize" | "waiting-to-prove" | "finalized"> {
  const { receipt, chain, targetChain, logIndex = 0 } = parameters;

  // Use viem's built-in functions but catch errors from getGames
  try {
    return await viemGetWithdrawalStatus(client, {
      receipt,
      chain,
      targetChain,
      logIndex,
    });
  } catch (error) {
    // If we get an AbiDecodingDataSizeTooSmallError, it means getGames failed due to custom extraData
    // For MegaETH, we need to manually check the withdrawal status by querying the portal contract
    if (
      (typeguards.isError(error) && error.name === "AbiDecodingDataSizeTooSmallError") ||
      (typeguards.isError(error) && error.message.includes("Data size"))
    ) {
      // Get the portal address
      const portalAddress = (() => {
        if (chain) {
          return targetChain.contracts.portal[chain.id].address;
        }
        return Object.values(targetChain.contracts.portal)[0].address;
      })();

      // Get the withdrawal from the receipt
      const withdrawals = getWithdrawals(receipt);
      const withdrawal = withdrawals[logIndex];

      if (!withdrawal) {
        throw new Error(`No withdrawal found at log index ${logIndex}`);
      }

      // Check if the withdrawal has been finalized
      // @ts-expect-error - viem 2.37 types require authorizationList but it's not actually needed for view functions
      const isFinalized = await readContract(client, {
        address: portalAddress,
        abi: finalizedWithdrawalsAbi,
        functionName: "finalizedWithdrawals",
        args: [withdrawal.withdrawalHash],
      });

      if (isFinalized) {
        return "finalized";
      }

      // For dispute game-based portals, we need to get the proof submitter address
      // Get the number of proof submitters for this withdrawal
      // @ts-expect-error - viem 2.37 types require authorizationList but it's not actually needed for view functions
      const numProofSubmitters = await readContract(client, {
        address: portalAddress,
        abi: numProofSubmittersAbi,
        functionName: "numProofSubmitters",
        args: [withdrawal.withdrawalHash],
      });

      // If no one has proven this withdrawal yet, check if a game exists
      if (numProofSubmitters === 0n) {
        const games = await getMegaETHGames(client, {
          chain,
          l2BlockNumber: receipt.blockNumber,
          targetChain,
        });

        return games.length > 0 ? "ready-to-prove" : "waiting-to-prove";
      }

      // Get the most recent proof submitter
      // @ts-expect-error - viem 2.37 types require authorizationList but it's not actually needed for view functions
      const proofSubmitter = await readContract(client, {
        address: portalAddress,
        abi: proofSubmittersAbi,
        functionName: "proofSubmitters",
        args: [withdrawal.withdrawalHash, numProofSubmitters - 1n],
      });

      // Check if the withdrawal has been proven by this submitter
      // @ts-expect-error - viem 2.37 types require authorizationList but it's not actually needed for view functions
      const provenWithdrawal = await readContract(client, {
        address: portalAddress,
        abi: provenWithdrawalsAbi,
        functionName: "provenWithdrawals",
        args: [withdrawal.withdrawalHash, proofSubmitter],
      });

      // If the withdrawal has a non-zero timestamp, it has been proven
      if (provenWithdrawal[1] > 0n) {
        // Check if the challenge period has passed using checkWithdrawal
        try {
          // checkWithdrawal will revert if the withdrawal can't be finalized yet
          // @ts-expect-error - viem 2.37 types require authorizationList but it's not actually needed for view functions
          await readContract(client, {
            address: portalAddress,
            abi: checkWithdrawalAbi,
            functionName: "checkWithdrawal",
            args: [withdrawal.withdrawalHash, proofSubmitter],
          });

          // If checkWithdrawal doesn't revert, the withdrawal is ready to finalize
          return "ready-to-finalize";
        } catch (checkError) {
          // If it reverts with specific errors, it means we're still waiting
          const errorMessage = typeguards.isError(checkError) ? checkError.message : "";
          if (
            errorMessage.includes("withdrawal has not matured yet") ||
            errorMessage.includes("output proposal has not been finalized yet") ||
            errorMessage.includes("output proposal in air-gap")
          ) {
            return "waiting-to-finalize";
          }
          // For other errors, still return waiting-to-finalize since it was proven
          return "waiting-to-finalize";
        }
      }

      // Should not reach here - if we have proof submitters but no valid proof,
      // something is wrong with the contract state
      throw new Error(`Unexpected state: ${numProofSubmitters} proof submitters but no valid proof found`);
    }
    throw error;
  }
}

/**
 * Get L2 output for MegaETH with custom game handling.
 * This wraps viem's getL2Output but catches errors from custom extraData format.
 */
export async function getL2Output(
  client: any,
  parameters: {
    l2BlockNumber: bigint;
    chain: Chain;
    targetChain: {
      contracts: {
        portal: { [sourceId: number]: { address: Address } };
        l2OutputOracle: { [sourceId: number]: { address: Address } };
        disputeGameFactory: { [sourceId: number]: { address: Address } };
      };
    };
  }
): Promise<{
  l2BlockNumber: bigint;
  outputIndex: bigint;
  outputRoot: `0x${string}`;
  timestamp: bigint;
}> {
  const { l2BlockNumber, chain, targetChain } = parameters;

  // Use viem's built-in function but catch errors from getGames
  try {
    return await viemGetL2Output(client, {
      l2BlockNumber,
      chain,
      targetChain,
    });
  } catch (error) {
    // If we get an AbiDecodingDataSizeTooSmallError, it means getGames failed due to custom extraData
    // For MegaETH, we use the custom game retrieval
    if (
      (typeguards.isError(error) && error.name === "AbiDecodingDataSizeTooSmallError") ||
      (typeguards.isError(error) && error.message.includes("Data size"))
    ) {
      // Get the games using our custom function
      const games = await getMegaETHGames(client, {
        chain,
        l2BlockNumber,
        targetChain,
      });

      if (games.length === 0) {
        throw new Error(`No games found for L2 block ${l2BlockNumber}`);
      }

      // Find the game that matches or is closest to our L2 block number
      const matchingGame = games.find((game) => game.l2BlockNumber === l2BlockNumber) || games[0];

      // Return the output in the expected format
      return {
        l2BlockNumber: matchingGame.l2BlockNumber,
        outputIndex: matchingGame.index,
        outputRoot: matchingGame.rootClaim,
        timestamp: matchingGame.timestamp,
      };
    }
    throw error;
  }
}

/**
 * Create a custom transport for MegaETH that intercepts eth_getProof calls
 * and redirects them to mega_getWithdrawalProof.
 */
export function createMegaETHTransport(baseTransport: any) {
  return (config: any) => {
    const transport = baseTransport(config);

    return {
      ...transport,
      async request({ method, params }: { method: string; params?: any[] }) {
        // Intercept eth_getProof calls and redirect to mega_getWithdrawalProof
        if (method === "eth_getProof") {
          return transport.request({
            method: "mega_getWithdrawalProof",
            params,
          });
        }
        // Pass through all other methods
        return transport.request({ method, params });
      },
    };
  };
}

/**
 * Build prove withdrawal for MegaETH.
 * Creates a client with custom transport that redirects eth_getProof to mega_getWithdrawalProof.
 */
export async function buildProveWithdrawal(
  client: any,
  parameters: {
    chain: Chain;
    withdrawal: any;
    output: {
      l2BlockNumber: bigint;
      outputIndex: bigint;
      outputRoot: `0x${string}`;
      timestamp: bigint;
    };
  }
): Promise<{
  l2OutputIndex: bigint;
  outputRootProof: {
    version: `0x${string}`;
    stateRoot: `0x${string}`;
    messagePasserStorageRoot: `0x${string}`;
    latestBlockhash: `0x${string}`;
  };
  withdrawalProof: readonly `0x${string}`[];
}> {
  // Create a wrapped client with custom transport that intercepts eth_getProof
  const wrappedClient = {
    ...client,
    async request({ method, params }: { method: string; params?: unknown[] }) {
      // Intercept eth_getProof calls and redirect to mega_getWithdrawalProof
      if (method === "eth_getProof") {
        return client.request({
          method: "mega_getWithdrawalProof",
          params,
        });
      }
      // Pass through all other methods
      return client.request({ method, params });
    },
  };

  // Call viem's buildProveWithdrawal with the wrapped client
  return await viemBuildProveWithdrawal(wrappedClient, parameters);
}

/**
 * Extend a viem client with MegaETH-specific withdrawal actions.
 * This teaches viem how to handle MegaETH's custom extraData format and RPC methods.
 *
 * @example
 * ```ts
 * const client = createPublicClient({ chain: megaeth, transport: http() });
 * const megaethClient = client.extend(megaethActions);
 *
 * // Now use standard viem op-stack functions - they work with MegaETH!
 * const status = await getWithdrawalStatus(megaethClient, { receipt, targetChain });
 * ```
 */
export const megaethActions = <
  TTransport extends Transport = Transport,
  TChain extends Chain | undefined = Chain | undefined,
  TAccount extends Account | undefined = Account | undefined
>(
  client: PublicClient<TTransport, TChain, TAccount>
) => ({
  getWithdrawalStatus: (
    parameters: Parameters<typeof getWithdrawalStatus>[1]
  ): ReturnType<typeof getWithdrawalStatus> => getWithdrawalStatus(client, parameters),
  getL2Output: (parameters: Parameters<typeof getL2Output>[1]): ReturnType<typeof getL2Output> =>
    getL2Output(client, parameters),
  buildProveWithdrawal: (
    parameters: Parameters<typeof buildProveWithdrawal>[1]
  ): ReturnType<typeof buildProveWithdrawal> => buildProveWithdrawal(client, parameters),
});
