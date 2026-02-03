import { CommonConfig, ProcessEnv } from "../common";

export class GaslessRelayerConfig extends CommonConfig {
  apiPollingInterval: number;
  apiEndpoint: string;

  relayerOriginChains: number[];
  relayerDestinationChains: number[];
  relayerTokenSymbols: string[];
  depositLookback: number;

  constructor(env: ProcessEnv) {
    super(env);

    const {
      API_POLLING_INTERVAL,
      API_GASLESS_ENDPOINT,
      MAX_RELAYER_DEPOSIT_LOOKBACK,
      RELAYER_ORIGIN_CHAINS,
      RELAYER_DESTINATION_CHAINS,
      RELAYER_TOKEN_SYMBOLS,
    } = env;
    this.apiPollingInterval = Number(API_POLLING_INTERVAL ?? 1); // Default to 1s
    this.apiEndpoint = String(API_GASLESS_ENDPOINT);

    const relayerOriginChains = new Set<number>(JSON.parse(RELAYER_ORIGIN_CHAINS ?? "[]"));
    this.relayerOriginChains = Array.from(relayerOriginChains);
    const relayerDestinationChains = new Set<number>(JSON.parse(RELAYER_DESTINATION_CHAINS ?? "[]"));
    this.relayerDestinationChains = Array.from(relayerDestinationChains);

    this.relayerTokenSymbols = JSON.parse(RELAYER_TOKEN_SYMBOLS); // Relayer token symbols must be defined.
    this.depositLookback = Number(MAX_RELAYER_DEPOSIT_LOOKBACK ?? 3600);
  }
}
