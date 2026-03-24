import winston from "winston";
import { HyperliquidExecutorClients } from "./HyperliquidExecutor";
import { constructClients, updateClients } from "../common";
import { Signer, getProvider, CHAIN_IDs } from "../utils";
import { HyperliquidExecutorConfig } from "./HyperliquidExecutorConfig";

export async function constructHyperliquidExecutorClients(
  config: HyperliquidExecutorConfig,
  logger: winston.Logger,
  baseSigner: Signer
): Promise<HyperliquidExecutorClients> {
  // hubPoolLookback can be very short since its not used for anything in the HyperliquidExecutor.
  const hubPoolLookback = 7200;
  const commonClients = await constructClients(logger, config, baseSigner, hubPoolLookback);

  // @dev No need to update the hub pool client since we don't call any functions on it. We only need the hubPool
  // Contract instance, signer, and chain ID.
  await updateClients(commonClients, config, logger);
  const dstProvider = await getProvider(CHAIN_IDs.HYPEREVM);
  return { ...commonClients, dstProvider };
}
