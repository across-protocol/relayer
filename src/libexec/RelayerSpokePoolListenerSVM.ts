import assert from "assert";
import minimist from "minimist";
import { Contract, utils as ethersUtils } from "ethers";
import { createSolanaRpcSubscriptions } from "@solana/kit";
import * as utils from "../../scripts/utils";
import {
  disconnectRedisClients,
  EventManager,
  exit,
  isDefined,
  getChainQuorum,
  getCurrentTime,
  getNetworkName,
  getNodeUrlList,
  getProvider,
  Logger,
  winston,
} from "../utils";
import { postEvents } from "./util/ipc";

const { NODE_SUCCESS, NODE_APP_ERR } = utils;
const abortController = new AbortController();

let logger: winston.Logger;
let chainId: number;
let chain: string;
let stop = false; // tbd whether this is required, or whether abortController is sufficient.

// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function listen(
  eventMgr: EventManager,
  _spokePool?: Contract,
  _eventNames?: string[],
  quorum = 1
): Promise<void> {
  const urls = Object.values(getNodeUrlList(chainId, quorum, "wss"));
  const nProviders = urls.length;
  assert(nProviders >= quorum, `Insufficient providers for ${chain} (required ${quorum} by quorum)`);

  const providers = urls.map((url) => createSolanaRpcSubscriptions(url));

  for (const provider of providers) {
    // Ideally, slotsUpdatesNotifications() would be used. Kit marks this as unstable for now.
    // https://github.com/anza-xyz/kit/blob/053b2caf7876deefb38d1a24a20ba962f162bbf1/packages/rpc-subscriptions-api/src/slots-updates-notifications.ts#L43
    const updates = await provider.slotNotifications().subscribe({ abortSignal: abortController.signal });

    for await (const update of updates) {
      const { slot: blockNumber } = update as { slot: bigint }; // Bodge: pretend slots are blocks.
      const currentTime = getCurrentTime(); // @todo Try to subscribe w/ timestamp updates.
      const events = eventMgr.tick();
      logger.debug({ at: "listen", message: "Got slot update.", update });
      postEvents(Number(blockNumber), currentTime, events);
    }
  }
}

/**
 * Main entry point.
 */
async function run(argv: string[]): Promise<void> {
  const minimistOpts = {
    string: ["lookback", "relayer", "spokepool"],
  };
  const args = minimist(argv, minimistOpts);

  ({ chainid: chainId } = args);
  const { lookback, relayer = null, blockrange: maxBlockRange = 10_000 } = args;
  lookback;
  assert(Number.isInteger(chainId), "chainId must be numeric ");
  assert(Number.isInteger(maxBlockRange), "maxBlockRange must be numeric");
  assert(!isDefined(relayer) || ethersUtils.isAddress(relayer), `relayer address is invalid (${relayer})`);

  const { quorum = getChainQuorum(chainId) } = args;
  assert(Number.isInteger(quorum), "quorum must be numeric ");

  chain = getNetworkName(chainId);

  const quorumProvider = await getProvider(chainId);
  quorumProvider;

  const opts = {
    quorum,
  };

  logger.debug({ at: "RelayerSpokePoolListener::run", message: `Starting ${chain} SpokePool Indexer.`, opts });

  process.on("SIGHUP", () => {
    logger.debug({ at: "Relayer#run", message: `Received SIGHUP in ${chain} listener, stopping...` });
    stop = true;
    abortController.abort();
  });

  process.on("disconnect", () => {
    logger.debug({ at: "Relayer::run", message: `${chain} parent disconnected, stopping...` });
    stop = true;
    abortController.abort();
  });

  const events = [];
  logger.debug({ at: "RelayerSpokePoolListener::run", message: `Starting ${chain} listener.`, events, opts });
  const eventMgr = new EventManager(logger, chainId, quorum);

  const spokePool = undefined;
  await listen(eventMgr, spokePool, events, quorum);
}

if (require.main === module) {
  logger = Logger;

  run(process.argv.slice(2))
    .then(() => {
      process.exitCode = NODE_SUCCESS;
    })
    .catch((error) => {
      logger.error({ at: "RelayerSpokePoolListener", message: `${chain} listener exited with error.`, error });
      process.exitCode = NODE_APP_ERR;
    })
    .finally(async () => {
      await disconnectRedisClients();
      logger.debug({ at: "RelayerSpokePoolListener", message: `Exiting ${chain} listener.` });
      exit(process.exitCode);
    });

  stop; // lint
}
