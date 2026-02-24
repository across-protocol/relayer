import { winston, CHAIN_IDs } from "../utils";
import { AcrossApiBaseClient } from "./AcrossApiBaseClient";

export function getAcrossIndexerHost(hubChainId: number): string {
  return (
    process.env.ACROSS_INDEXER_HOST ??
    (hubChainId === CHAIN_IDs.MAINNET ? "indexer.api.across.to" : "dev.indexer.api.across.to")
  );
}

export class AcrossIndexerApiClient extends AcrossApiBaseClient {
  constructor(logger: winston.Logger, timeoutMs = 3000) {
    super(logger, `https://${getAcrossIndexerHost(CHAIN_IDs.MAINNET)}/api`, "AcrossIndexerApiClient", timeoutMs);
  }
}
