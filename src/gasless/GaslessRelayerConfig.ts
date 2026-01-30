import { CommonConfig, ProcessEnv } from "../common";

export class GaslessRelayerConfig extends CommonConfig {
  apiPollingInterval: number;
  apiEndpoint: string;

  constructor(env: ProcessEnv) {
    super(env);

    const { API_POLLING_INTERVAL, API_GASLESS_ENDPOINT } = env;
    this.apiPollingInterval = Number(API_POLLING_INTERVAL ?? 1); // Default to 1s
    this.apiEndpoint = String(API_GASLESS_ENDPOINT);
  }
}
