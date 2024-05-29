import assert from "assert";
import { ChildProcess, spawn } from "child_process";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import {
  config,
  delay,
  disconnectRedisClients,
  getChainQuorum,
  getCurrentTime,
  getNetworkName,
  Signer,
  startupLogLevel,
  winston,
} from "../utils";
import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";
import { constructRelayerClients, updateRelayerClients } from "./RelayerClientHelper";
config();
let logger: winston.Logger;

const randomNumber = () => Math.floor(Math.random() * 1_000_000);

type IndexerOpts = {
  lookback?: number;
  blockRange?: number;
};

function startWorker(cmd: string, path: string, chainId: number, opts: IndexerOpts): ChildProcess {
  const args = Object.entries(opts)
    .map(([k, v]) => [`--${k}`, `${v}`])
    .flat();
  return spawn(cmd, [path, "--chainId", chainId.toString(), ...args], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
}

function startWorkers(config: RelayerConfig): { [chainId: number]: ChildProcess } {
  const sampleOpts = { lookback: config.maxRelayerLookBack };

  const chainIds = sdkUtils.dedupArray([...config.relayerOriginChains, ...config.relayerDestinationChains]);
  assert(chainIds.length > 0); // @todo: Fix to work with undefined chain IDs (default to the complete set).

  return Object.fromEntries(
    chainIds.map((chainId: number) => {
      // Identify the lowest configured deposit confirmation threshold for use as indexer finality.
      const finality = config.minDepositConfirmations[chainId].at(0)?.minConfirmations ?? 1024;
      const blockRange = config.maxRelayerLookBack[chainId] ?? 5_000; // 5k is a safe default.
      const quorum = getChainQuorum(chainId);

      const opts = { ...sampleOpts, finality, blockRange, quorum };
      const chain = getNetworkName(chainId);
      const child = startWorker("node", config.indexerPath, chainId, opts);
      logger.debug({ at: "Relayer#run", message: `Spawned ${chain} SpokePool indexer.`, args: child.spawnargs });
      return [chainId, child];
    })
  );
}

export async function runRelayer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const relayerRun = randomNumber();
  const startTime = getCurrentTime();

  logger = _logger;
  const config = new RelayerConfig(process.env);

  let workers: { [chainId: number]: ChildProcess };
  if (config.externalIndexer) {
    workers = startWorkers(config);
  }

  const loop = config.pollingDelay > 0;
  let stop = !loop;
  process.on("SIGHUP", () => {
    logger.debug({
      at: "Relayer#run",
      message: "Received SIGHUP, stopping at end of current loop.",
    });
    stop = true;
  });

  logger[startupLogLevel(config)]({ at: "Relayer#run", message: "Relayer started 🏃‍♂️", config, relayerRun });
  const relayerClients = await constructRelayerClients(logger, config, baseSigner, workers);
  const relayer = new Relayer(await baseSigner.getAddress(), logger, relayerClients, config);

  let run = 1;
  try {
    do {
      if (loop) {
        logger.debug({ at: "relayer#run", message: `Starting relayer execution loop ${run}.` });
      }

      const tLoopStart = performance.now();
      if (run !== 1) {
        await relayerClients.configStoreClient.update();
        await relayerClients.hubPoolClient.update();
      }
      await updateRelayerClients(relayerClients, config);

      if (!config.skipRelays) {
        // Since the above spoke pool updates are slow, refresh token client before sending rebalances now:
        relayerClients.tokenClient.clearTokenData();
        await relayerClients.tokenClient.update();
        const simulate = !config.sendingRelaysEnabled;
        await relayer.checkForUnfilledDepositsAndFill(config.sendingSlowRelaysEnabled, simulate);
      }

      // Unwrap WETH after filling deposits so we don't mess up slow fill logic, but before rebalancing
      // any tokens so rebalancing can take into account unwrapped WETH balances.
      await relayerClients.inventoryClient.unwrapWeth();

      if (!config.skipRebalancing) {
        // Since the above spoke pool updates are slow, refresh token client before sending rebalances now:
        relayerClients.tokenClient.clearTokenData();
        await relayerClients.tokenClient.update();
        await relayerClients.inventoryClient.rebalanceInventoryIfNeeded();
      }

      // Clear state from profit and token clients. These are updated on every iteration and should start fresh.
      relayerClients.profitClient.clearUnprofitableFills();
      relayerClients.tokenClient.clearTokenShortfall();

      const tLoopStop = performance.now();
      const runTime = Math.round((tLoopStop - tLoopStart) / 1000);
      if (loop) {
        logger.debug({
          at: "Relayer#run",
          message: `Completed relayer execution loop ${run++} in ${runTime} seconds.`,
        });

        if (!stop && runTime < config.pollingDelay) {
          const delta = config.pollingDelay - runTime;
          logger.debug({
            at: "relayer#run",
            message: `Waiting ${delta} s before next loop.`,
          });
          await delay(delta);
        }
      }
    } while (!stop);
  } finally {
    if (config.externalIndexer) {
      Object.entries(workers).forEach(([_chainId, worker]) => {
        logger.debug({ at: "Relayer::runRelayer", message: `Cleaning up indexer for chainId ${_chainId}.` });
        worker.kill("SIGHUP");
      });
    }
    await disconnectRedisClients(logger);
  }

  const runtime = getCurrentTime() - startTime;
  logger.debug({ at: "Relayer#index", message: `Completed relayer run ${relayerRun} in ${runtime} seconds.` });
}
