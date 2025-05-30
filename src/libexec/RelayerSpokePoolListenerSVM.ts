import assert from "assert";
import minimist from "minimist";
import { utils as ethersUtils } from "ethers";
import { address, createSolanaRpcSubscriptions } from "@solana/kit";
import { arch } from "@across-protocol/sdk";
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
  getSvmProvider,
  Logger,
  SvmAddress,
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

async function listen(eventMgr: EventManager, _spokePool: SvmAddress, eventNames: string[], quorum = 1): Promise<void> {
  const urls = Object.values(getNodeUrlList(chainId, quorum, "wss"));
  const nProviders = urls.length;
  assert(nProviders >= quorum, `Insufficient providers for ${chain} (required ${quorum} by quorum)`);

  const eventAuthority = await arch.svm.getEventAuthority();
  const config = { commitment: "confirmed" } as const;
  const { signal: abortSignal } = abortController;
  const subscribe = async (url: string) => {
    const provider = createSolanaRpcSubscriptions(url);
    return await provider.logsNotifications({ mentions: [address(eventAuthority)] }, config).subscribe({ abortSignal });
  };
  const subscriptions = await Promise.all(urls.map(subscribe));

  // These are Log fields that are irrelevant for SVM and are only needed for the relayer messaging interface.
  // These will ultimately be dropped from the messaging interface.
  const unusedFields = {
    blockHash: "",
    transactionIndex: 0,
    logIndex: 0,
    data: "",
    topics: [],
  };

  const eventsClient = await arch.svm.SvmCpiEventsClient.create(getSvmProvider());
  const readEvent = async (subscription, provider: string) => {
    for await (const log of subscription) {
      const {
        value: { signature },
        context: { slot },
      } = log;
      const rawEvents = await eventsClient.readEventsFromSignature(signature, "confirmed");

      const events = rawEvents
        .filter(({ name }) => eventNames.includes(name))
        .map(({ program, name, data }) => ({
          ...unusedFields,
          transactionHash: signature,
          blockNumber: Number(slot),
          address: program,
          event: name,
          removed: false,
          args: arch.svm.unwrapEventData(data),
        }));

      if (events.length > 0) {
        events.forEach((event) => eventMgr.add(event, provider));
        const { blockNumber: maxSlot } = events.reduce((a, b) => (a.blockNumber > b.blockNumber ? a : b), {
          blockNumber: 0,
        });
        // @todo: Must be able to tick the chain without deposit events occurring for deposit confirmations to work.
        postEvents(maxSlot, getCurrentTime(), eventMgr.tick());
      }
    }
  };

  await Promise.all(subscriptions.map((sub, i) => readEvent(sub, urls[i])));
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

  const events = ["FundsDeposited", "FilledRelay", "RequestedSpeedUpDeposit"];
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
