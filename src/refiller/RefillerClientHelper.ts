import winston from "winston";
import { RefillerClients } from "./Refiller";
import { constructClients, getEnabledChainsInBlockRange, updateClients } from "../common";
import { getProvider, mapAsync, Signer } from "../utils";
import { BalanceAllocator } from "../clients";
import { RefillerConfig } from "./RefillerConfig";

export async function constructRefillerClients(
  config: RefillerConfig,
  logger: winston.Logger,
  baseSigner: Signer
): Promise<RefillerClients> {
  // Set hubPoolLookback conservatively to be equal to one month of blocks. If the config.maxRelayerLookBack
  // exceeds half a month, then we'll just use the gensis block since in that case, this monitor is being used
  // for non-production circumstances.
  const hubPoolLookback = config.maxRelayerLookBack > 3600 * 24 * 15 ? undefined : 3600 * 24 * 30;
  const commonClients = await constructClients(logger, config, baseSigner, hubPoolLookback);
  const { hubPoolClient, configStoreClient } = commonClients;

  await updateClients(commonClients, config, logger);
  await hubPoolClient.update();

  const enabledChains = getEnabledChainsInBlockRange(
    configStoreClient,
    config.spokePoolChainsOverride,
    hubPoolLookback
  );
  const l2Providers = Object.fromEntries(
    await mapAsync(enabledChains, async (chainId) => [chainId, await getProvider(chainId)])
  );
  const balanceAllocator = new BalanceAllocator(l2Providers);

  return { ...commonClients, balanceAllocator };
}
