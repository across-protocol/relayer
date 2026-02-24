import { CommonConfig, ProcessEnv } from "../common";

export class DepositAddressHandlerConfig extends CommonConfig {
  apiEndpoint: string;

  indexerApiEndpoint: string;
  indexerPollingInterval: number;

  relayerOriginChains: number[];
  relayerDestinationChains: number[];
  depositLookback: number;
  apiTimeoutOverride: number;
  initializationRetryAttempts: number;

  constructor(env: ProcessEnv) {
    super(env);

    const {
      INDEXER_API_POLLING_INTERVAL,
      INDEXER_API_ENDPOINT,
      API_ENDPOINT,
      MAX_RELAYER_DEPOSIT_LOOKBACK,
      RELAYER_ORIGIN_CHAINS,
      API_TIMEOUT_OVERRIDE,
      INITIALIZATION_RETRY_ATTEMPTS,
    } = env;
    this.indexerPollingInterval = Number(INDEXER_API_POLLING_INTERVAL ?? 1); // Default to 1s
    this.indexerApiEndpoint = String(INDEXER_API_ENDPOINT);
    this.apiEndpoint = String(API_ENDPOINT);

    const relayerOriginChains = new Set<number>(JSON.parse(RELAYER_ORIGIN_CHAINS ?? "[]"));
    this.relayerOriginChains = Array.from(relayerOriginChains);

    this.depositLookback = Number(MAX_RELAYER_DEPOSIT_LOOKBACK ?? 3600);

    this.apiTimeoutOverride = Number(API_TIMEOUT_OVERRIDE ?? 3000); // In ms
    this.initializationRetryAttempts = Number(INITIALIZATION_RETRY_ATTEMPTS ?? 3);
  }
}
