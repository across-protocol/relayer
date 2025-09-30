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
  // hubPoolLookback can be very short since its not used for anything in the Refiller.
  const hubPoolLookback = 7200;
  const commonClients = await constructClients(logger, config, baseSigner, hubPoolLookback);
  const { configStoreClient } = commonClients;

  // @dev No need to update the hub pool client since we don't call any functions on it. We only need the hubPool
  // Contract instance, signer, and chain ID.
  await updateClients(commonClients, config, logger);

  // Use latest set of enabled chains. This means we will not refill gas on chains that are currently disabled, but
  // that seems reasonable since those chains presumably will not have deposits or fills.
  const latestMainnetBlock = commonClients.configStoreClient.latestHeightSearched;
  const enabledChains = getEnabledChainsInBlockRange(
    configStoreClient,
    config.spokePoolChainsOverride,
    latestMainnetBlock
  );
  const l2Providers = Object.fromEntries(
    await mapAsync(enabledChains, async (chainId) => [chainId, await getProvider(chainId)])
  );
  const balanceAllocator = new BalanceAllocator(l2Providers);

  return { ...commonClients, balanceAllocator };
}
