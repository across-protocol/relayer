import { CommonConfig, ProcessEnv } from "../common";

export class GaslessRelayerConfig extends CommonConfig {
  apiPollingInterval: number;

  constructor(env: ProcessEnv) {
    super(env);

    const { API_POLLING_INTERVAL } = env;
    this.apiPollingInterval = Number(API_POLLING_INTERVAL ?? 1); // Default to 1s
  }
}
