import winston from "winston";
import { HyperliquidBaseClients } from "./HyperliquidBase";
import { HyperliquidFinalizerClients } from "./HyperliquidFinalizer";
import { constructClients, getEnabledChainsInBlockRange, updateClients } from "../common";
import { Signer, mapAsync, getProvider, chainIsCCTPEnabled, chainIsOFTEnabled, CHAIN_IDs } from "../utils";
import { HyperliquidBotConfig } from "./HyperliquidBotConfig";

export async function constructHyperliquidExecutorClients(
  config: HyperliquidBotConfig,
  logger: winston.Logger,
  baseSigner: Signer
): Promise<HyperliquidBaseClients> {
  // hubPoolLookback can be very short since its not used for anything in the Hyperliquid bots.
  const hubPoolLookback = 7200;
  const commonClients = await constructClients(logger, config, baseSigner, hubPoolLookback);

  // @dev No need to update the hub pool client since we don't call any functions on it. We only need the hubPool
  // Contract instance, signer, and chain ID.
  await updateClients(commonClients, config, logger);
  const dstProvider = await getProvider(CHAIN_IDs.HYPEREVM);
  return { ...commonClients, dstProvider };
}

export async function constructHyperliquidFinalizerClients(
  config: HyperliquidBotConfig,
  logger: winston.Logger,
  baseSigner: Signer
): Promise<HyperliquidFinalizerClients> {
  // Construct shared clients of all Hyperliquid bot types.
  const commonClients = await constructHyperliquidExecutorClients(config, logger, baseSigner);
  const { configStoreClient } = commonClients;

  // Add L2 providers for the finalizer bot.
  const latestMainnetBlock = commonClients.configStoreClient.latestHeightSearched;
  const enabledChains = getEnabledChainsInBlockRange(
    configStoreClient,
    config.spokePoolChainsOverride,
    latestMainnetBlock
  ).filter((chainId) => chainIsCCTPEnabled(chainId) || chainIsOFTEnabled(chainId));
  const l2ProvidersByChain = Object.fromEntries(
    await mapAsync(enabledChains, async (chainId) => [chainId, await getProvider(chainId)])
  );
  return { ...commonClients, l2ProvidersByChain };
}
