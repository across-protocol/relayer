import { winston, processEndPollingLoop, config, startupLogLevel, Signer, disconnectRedisClients } from "../utils";
import { Refiller } from "./Refiller";
import { constructRefillerClients } from "./RefillerClientHelper";
import { RefillerConfig } from "./RefillerConfig";
config();
let logger: winston.Logger;

export async function runRefiller(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const config = new RefillerConfig(process.env);
  const clients = await constructRefillerClients(config, logger, baseSigner);
  const refiller = new Refiller(logger, config, clients);
  await refiller.initialize();

  try {
    logger[startupLogLevel(config)]({ at: "Refiller#index", message: "Refiller started ⛽️", config });
    for (;;) {
      const loopStart = Date.now();
      await refiller.refillNativeTokenBalances();

      await clients.multiCallerClient.executeTxnQueues();

      logger.debug({ at: "Monitor#index", message: `Time to loop: ${(Date.now() - loopStart) / 1000}s` });

      if (await processEndPollingLoop(logger, "Monitor#index", config.pollingDelay)) {
        break;
      }
    }
  } finally {
    await disconnectRedisClients(logger);
  }
}
