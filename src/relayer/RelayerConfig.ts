import { CommonConfig, ProcessEnv } from "../common";
export class RelayerConfig extends CommonConfig {
  readonly maxRelayerLookBack: { [chainId: number]: number };

  constructor(env: ProcessEnv) {
    const { MAX_RELAYER_DEPOSIT_LOOK_BACK } = env;
    super(env);
    this.maxRelayerLookBack = MAX_RELAYER_DEPOSIT_LOOK_BACK ? JSON.parse(MAX_RELAYER_DEPOSIT_LOOK_BACK) : {};
  }
}
