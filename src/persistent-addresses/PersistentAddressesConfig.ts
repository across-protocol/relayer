import { CommonConfig, ProcessEnv } from "../common";

export class PersistentAddressesConfig extends CommonConfig {
  apiEndpoint: string;

  indexerApiEndpoint: string;
  indexerPollingInterval: number;

  relayerOriginChains: number[];
  relayerDestinationChains: number[];
  relayerTokenSymbols: string[];
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
      RELAYER_DESTINATION_CHAINS,
      RELAYER_TOKEN_SYMBOLS,
      API_TIMEOUT_OVERRIDE,
      INITIALIZATION_RETRY_ATTEMPTS,
    } = env;
    this.indexerPollingInterval = Number(INDEXER_API_POLLING_INTERVAL ?? 1); // Default to 1s
    this.indexerApiEndpoint = String(INDEXER_API_ENDPOINT);
    this.apiEndpoint = String(API_ENDPOINT);

    const relayerOriginChains = new Set<number>(JSON.parse(RELAYER_ORIGIN_CHAINS ?? "[]"));
    this.relayerOriginChains = Array.from(relayerOriginChains);
    const relayerDestinationChains = new Set<number>(JSON.parse(RELAYER_DESTINATION_CHAINS ?? "[]"));
    this.relayerDestinationChains = Array.from(relayerDestinationChains);

    this.relayerTokenSymbols = JSON.parse(RELAYER_TOKEN_SYMBOLS); // Relayer token symbols must be defined.
    this.depositLookback = Number(MAX_RELAYER_DEPOSIT_LOOKBACK ?? 3600);

    this.apiTimeoutOverride = Number(API_TIMEOUT_OVERRIDE ?? 3000); // In ms
    this.initializationRetryAttempts = Number(INITIALIZATION_RETRY_ATTEMPTS ?? 3);
  }
}
