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
