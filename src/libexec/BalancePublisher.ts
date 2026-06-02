import assert from "assert";
import minimist from "minimist";
import {
  type Abi,
  type AbiEvent,
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  isAddress,
} from "viem";
import { getAbiItem } from "viem/utils";
import { EventListener } from "../clients";
import ERC20_ABI from "../common/abi/MinimalERC20.json";
import {
  connectRedisClient,
  disconnectRedisClient,
  getChainQuorum,
  getNetworkName,
  getNodeUrlList,
  getProviderHeaders,
  getViemChain,
  isDefined,
  Logger,
  RedisClient,
  scheduleSequentialTask,
  winston,
} from "../utils";
import { Log } from "../interfaces";
import { bootstrap, waitForAbort } from "./util/bootstrap";

const PROGRAM = "BalancePublisher";
const CHANNEL = "balance-events";

// Default cadence for on-chain balance snapshots. Override with --interval <secs>.
const DEFAULT_SNAPSHOT_INTERVAL_SECS = 60;

// Multicall3's `blockAndAggregate`: aggregates the calls AND returns the block
// they executed against, so the block number and balances are read in one
// eth_call and are guaranteed consistent. Reverts the whole batch if any call
// fails, so the published snapshot set is always complete or absent.
// TODO: viem's exported `multicall3Abi` only covers aggregate3/getEthBalance/
// getCurrentBlockTimestamp — upstream blockAndAggregate so this local ABI
// (and the manual encode/decode below) can be dropped.
const MULTICALL3_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
        ],
        name: "calls",
        type: "tuple[]",
      },
    ],
    name: "blockAndAggregate",
    outputs: [
      { name: "blockNumber", type: "uint256" },
      { name: "blockHash", type: "bytes32" },
      {
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
        name: "returnData",
        type: "tuple[]",
      },
    ],
    stateMutability: "payable",
    type: "function",
  },
] as const satisfies Abi;

const transferAbi = getAbiItem({ abi: ERC20_ABI, name: "Transfer" });
if (!transferAbi || transferAbi.type !== "event") {
  throw new Error("MinimalERC20 ABI is missing Transfer event");
}
const TRANSFER_EVENT: AbiEvent = transferAbi;

const abortController = new AbortController();

let logger: winston.Logger;
let chainId: number;
let chain: string;
let redis: RedisClient | undefined;

async function publish(token: string, log: Log): Promise<void> {
  const at = `${PROGRAM}::publish`;
  if (!isDefined(redis)) {
    return;
  }

  const payload = {
    type: "transfer",
    schema_version: 1,
    platform: `chainId:${chainId}`,
    observed_at: new Date().toISOString(),
    log,
  };

  try {
    await redis.publish(CHANNEL, JSON.stringify(payload));
  } catch (err) {
    logger.warn({ at, message: `Failed to publish ${chain} Transfer event.`, token, cause: String(err) });
  }
}

type PublicClient = ReturnType<typeof createPublicClient>;

/**
 * Read every token's `balanceOf(address)` in a single multicall and broadcast a
 * `snapshot` per token. The ledger uses the first snapshot per (platform, token)
 * to seed an opening balance, and later snapshots to detect drift. Balances are
 * read at one block so they share a consistent `block_number`.
 */
async function publishSnapshots(publicClient: PublicClient, tokens: string[], address: string): Promise<void> {
  const at = `${PROGRAM}::publishSnapshots`;
  if (!isDefined(redis)) {
    return;
  }
  const client = redis;

  const multicall3 = getViemChain(chainId).contracts?.multicall3?.address;
  if (!isDefined(multicall3)) {
    logger.warn({ at, message: `No multicall3 deployment for ${chain}; cannot snapshot balances.` });
    return;
  }

  const calls = tokens.map((token) => ({
    target: token as `0x${string}`,
    callData: encodeFunctionData({
      abi: ERC20_ABI as Abi,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    }),
  }));

  let blockNumber: bigint;
  let returnData: readonly { success: boolean; returnData: `0x${string}` }[];
  try {
    const { result } = await publicClient.simulateContract({
      address: multicall3,
      abi: MULTICALL3_ABI,
      functionName: "blockAndAggregate",
      args: [calls],
    });
    [blockNumber, , returnData] = result;
  } catch (err) {
    logger.warn({ at, message: `Failed to read ${chain} balances.`, cause: String(err) });
    return;
  }

  await Promise.all(
    tokens.map(async (token, i) => {
      const balance = decodeFunctionResult({
        abi: ERC20_ABI as Abi,
        functionName: "balanceOf",
        data: returnData[i].returnData,
      }) as bigint;

      const payload = {
        type: "snapshot",
        platform: `chainId:${chainId}`,
        token,
        block_number: Number(blockNumber),
        // Absolute on-chain balance, source-native integer string.
        balance: balance.toString(),
        observed_at: new Date().toISOString(),
      };

      try {
        await client.publish(CHANNEL, JSON.stringify(payload));
      } catch (err) {
        logger.warn({ at, message: `Failed to publish ${chain} snapshot.`, token, cause: String(err) });
      }
    })
  );
}

async function run(argv: string[]): Promise<void> {
  const at = `${PROGRAM}::run`;
  const minimistOpts = { string: ["tokens", "address"] };
  const args = minimist(argv, minimistOpts);

  ({ chainid: chainId } = args);
  assert(Number.isInteger(chainId), "chainId must be numeric");

  const address: string = args.address ?? "";
  assert(isAddress(address), `Invalid address (--address ${address})`);

  const tokens: string[] = (args.tokens ?? "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  assert(tokens.length > 0, "at least one token contract required (--tokens 0x...,0x...)");
  tokens.forEach((token) => assert(isAddress(token), `Invalid token address (${token})`));

  const { quorum = getChainQuorum(chainId) } = args;
  assert(Number.isInteger(quorum), "quorum must be numeric");

  const { interval = DEFAULT_SNAPSHOT_INTERVAL_SECS } = args;
  assert(Number.isInteger(interval) && interval > 0, "interval must be a positive integer (seconds)");

  chain = getNetworkName(chainId);
  redis = await connectRedisClient(logger);

  logger.debug({ at, message: `Starting ${chain} balance publisher.`, address, tokens, quorum });

  // viem ANDs the args filter, so we need separate subscriptions for `from = address`
  // and `to = address` to get OR semantics. Self-transfers match both; subscriber
  // dedupes on (platform, source_event_id).
  const listener = new EventListener(chainId, logger, quorum);
  const handler = (token: string) => (log: Log) => {
    void publish(token, log);
  };
  tokens.forEach((token) => {
    listener.onEvent(token, TRANSFER_EVENT, handler(token), { from: address });
    listener.onEvent(token, TRANSFER_EVENT, handler(token), { to: address });
  });

  // Periodic on-chain balance snapshots, for the ledger to seed opening balances
  // and detect drift. An http client (multicall is a request/response read, not a
  // subscription); one provider suffices for a read.
  const [[provider, url]] = Object.entries(getNodeUrlList(chainId, quorum, "https"));
  const publicClient = createPublicClient({
    chain: getViemChain(chainId),
    transport: http(url, { fetchOptions: { headers: getProviderHeaders(provider, chainId) } }),
  });
  const snapshot = () => publishSnapshots(publicClient, tokens, address);
  void snapshot(); // emit a baseline immediately on startup
  scheduleSequentialTask(`${chain} balanceSnapshot`, logger, snapshot, interval, abortController.signal);

  await waitForAbort(abortController.signal);

  if (isDefined(redis)) {
    await disconnectRedisClient(redis, logger);
  }
}

if (require.main === module) {
  logger = Logger;
  bootstrap({ program: PROGRAM, abortController, chainName: () => chain, run });
}
