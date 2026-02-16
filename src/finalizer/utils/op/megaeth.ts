import { Account, Address, Chain, defineChain, PublicClient, TransactionReceipt, Transport, zeroAddress } from "viem";
import { readContract } from "viem/actions";
import { chainConfig, getWithdrawals, buildProveWithdrawal as viemBuildProveWithdrawal } from "viem/op-stack";
import { CHAIN_IDs } from "../../../utils";

/**
 * Minimal ABI definitions for the contract functions we need.
 * Viem doesn't export ABIs from its public API, and importing from JSON loses type safety,
 * so we define minimal typed ABIs here. These match the function signatures from the OP Stack
 * contracts but only include the functions we actually call.
 */
const disputeGameFactoryAbi = [
  {
    type: "function",
    name: "gameCount",
    inputs: [],
    outputs: [{ name: "gameCount_", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findLatestGames",
    inputs: [
      { name: "_gameType", type: "uint32", internalType: "GameType" },
      { name: "_start", type: "uint256", internalType: "uint256" },
      { name: "_n", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      {
        name: "games_",
        type: "tuple[]",
        internalType: "struct IDisputeGameFactory.GameSearchResult[]",
        components: [
          { name: "index", type: "uint256", internalType: "uint256" },
          { name: "metadata", type: "bytes32", internalType: "GameId" },
          { name: "timestamp", type: "uint64", internalType: "Timestamp" },
          { name: "rootClaim", type: "bytes32", internalType: "Claim" },
          { name: "extraData", type: "bytes", internalType: "bytes" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

const portal2Abi = [
  {
    type: "function",
    name: "respectedGameType",
    inputs: [],
    outputs: [{ name: "", type: "uint32", internalType: "GameType" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "finalizedWithdrawals",
    inputs: [{ name: "", type: "bytes32", internalType: "bytes32" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "numProofSubmitters",
    inputs: [{ name: "_withdrawalHash", type: "bytes32", internalType: "bytes32" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "proofSubmitters",
    inputs: [
      { name: "", type: "bytes32", internalType: "bytes32" },
      { name: "", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "provenWithdrawals",
    inputs: [
      { name: "", type: "bytes32", internalType: "bytes32" },
      { name: "", type: "address", internalType: "address" },
    ],
    outputs: [
      { name: "disputeGameProxy", type: "address", internalType: "contract IDisputeGame" },
      { name: "timestamp", type: "uint64", internalType: "uint64" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "checkWithdrawal",
    inputs: [
      { name: "_withdrawalHash", type: "bytes32", internalType: "bytes32" },
      { name: "_proofSubmitter", type: "address", internalType: "address" },
    ],
    outputs: [],
    stateMutability: "view",
  },
] as const;

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
  sourceId: CHAIN_IDs.MAINNET,
});

/**
 * MegaETH-specific viem actions for withdrawal finalization.
 * MegaETH uses a custom 24-byte extraData format instead of the standard 32-byte uint256.
 *
 * Note: We reuse viem's standard OP Stack ABIs (disputeGameFactoryAbi, portal2Abi, portalAbi)
 * since MegaETH follows the same contract interfaces, just with custom extraData encoding.
 */

/**
 * Decode MegaETH's custom 24-byte extraData format.
 * Format: [uint64 l2BlockNumber, uint64 parentGameIndex, uint64 duplicationCounter]
 * @see https://github.com/boundless-xyz/kailua/blob/4b315c5b10d61f28aeb1fc5a30e58a3cefb8de02/crates/contracts/foundry/src/KailuaGame.sol#L83
 */
function decodeExtraData(extraData: `0x${string}`): {
  l2BlockNumber: bigint;
  parentGameIndex: bigint;
  duplicationCounter: bigint;
} {
  const data = extraData.slice(2); // Remove 0x prefix

  // MegaETH uses 24-byte (48 hex char) extraData format
  if (data.length !== 48) {
    throw new Error(`Invalid MegaETH extraData length: expected 48 hex chars (24 bytes), got ${data.length}`);
  }

  // Format: [8 bytes l2BlockNumber][8 bytes parentGameIndex][8 bytes duplicationCounter]
  const l2BlockNumberHex = data.slice(0, 16); // First 8 bytes = 16 hex chars
  const parentGameIndexHex = data.slice(16, 32); // Next 8 bytes = 16 hex chars
  const duplicationCounterHex = data.slice(32, 48); // Last 8 bytes = 16 hex chars

  const l2BlockNumber = BigInt("0x" + l2BlockNumberHex);
  const parentGameIndex = BigInt("0x" + parentGameIndexHex);
  const duplicationCounter = BigInt("0x" + duplicationCounterHex);

  return { l2BlockNumber, parentGameIndex, duplicationCounter };
}

/**
 * Get dispute games for MegaETH with custom extraData handling.
 * This is a modified version of viem's getGames that handles MegaETH's 24-byte extraData.
 */
export async function getMegaETHGames(
  client: any,
  parameters: {
    chain?: Chain;
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
  const { chain = client.chain, limit = 100, targetChain } = parameters;

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
      abi: disputeGameFactoryAbi,
      functionName: "gameCount",
      args: [],
      address: disputeGameFactoryAddress,
    }),
    // @ts-expect-error - viem 2.37 types require authorizationList but it's not actually needed for view functions
    readContract(client, {
      abi: portal2Abi,
      functionName: "respectedGameType",
      address: portalAddress,
    }),
  ]);

  // Get latest games
  // @ts-expect-error - viem 2.37 types require authorizationList but it's not actually needed for view functions
  const gamesResult = await readContract(client, {
    abi: disputeGameFactoryAbi,
    functionName: "findLatestGames",
    address: disputeGameFactoryAddress,
    args: [gameType, BigInt(Math.max(0, Number(gameCount - 1n))), BigInt(Math.min(limit, Number(gameCount)))],
  });

  // Process games with custom extraData decoding
  const games = gamesResult.map((game) => {
    const { l2BlockNumber: blockNumber } = decodeExtraData(game.extraData);
    return { ...game, l2BlockNumber: blockNumber };
  });

  return games;
}

/**
 * Get withdrawal status for MegaETH.
 * Uses custom implementation to handle MegaETH's 24-byte extraData format.
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
    abi: portal2Abi,
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
    abi: portal2Abi,
    functionName: "numProofSubmitters",
    args: [withdrawal.withdrawalHash],
  });

  // If no one has proven this withdrawal yet, check if a game exists
  if (numProofSubmitters === 0n) {
    const games = await getMegaETHGames(client, {
      chain,
      targetChain,
    });

    return games.length > 0 ? "ready-to-prove" : "waiting-to-prove";
  }

  // Get the most recent proof submitter
  // @ts-expect-error - viem 2.37 types require authorizationList but it's not actually needed for view functions
  const proofSubmitter = await readContract(client, {
    address: portalAddress,
    abi: portal2Abi,
    functionName: "proofSubmitters",
    args: [withdrawal.withdrawalHash, numProofSubmitters - 1n],
  });

  // Check if the withdrawal has been proven by this submitter
  // @ts-expect-error - viem 2.37 types require authorizationList but it's not actually needed for view functions
  const provenWithdrawal = await readContract(client, {
    address: portalAddress,
    abi: portal2Abi,
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
        abi: portal2Abi,
        functionName: "checkWithdrawal",
        args: [withdrawal.withdrawalHash, proofSubmitter],
      });
      return "ready-to-finalize";
    } catch {
      return "waiting-to-finalize";
    }
  }

  // Should not reach here - if we have proof submitters but no valid proof,
  // something is wrong with the contract state
  throw new Error(`Unexpected state: ${numProofSubmitters} proof submitters but no valid proof found`);
}

/**
 * Get L2 output for MegaETH.
 * Uses custom implementation to handle MegaETH's 24-byte extraData format.
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

  // Use custom game retrieval for MegaETH's 24-byte extraData format
  const games = await getMegaETHGames(client, {
    chain,
    targetChain,
  });

  if (games.length === 0) {
    throw new Error(`No games found for L2 block ${l2BlockNumber}`);
  }

  // Find the game that covers our L2 block number
  const matchingGame = games.find((game) => game.l2BlockNumber >= l2BlockNumber);

  if (!matchingGame) {
    throw new Error(`No game found covering L2 block ${l2BlockNumber}`);
  }

  return {
    l2BlockNumber: matchingGame.l2BlockNumber,
    outputIndex: matchingGame.index,
    outputRoot: matchingGame.rootClaim,
    timestamp: matchingGame.timestamp,
  };
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
