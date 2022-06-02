import { CommonConfig, ProcessEnv } from "../common";
export class RelayerConfig extends CommonConfig {
  readonly maxRelayerLookBack: { [chainId: number]: number };
  readonly sendingRelaysEnabled: boolean;

  constructor(env: ProcessEnv) {
    const { MAX_RELAYER_DEPOSIT_LOOK_BACK, SEND_RELAYS } = env;
    super(env);
    this.maxRelayerLookBack = MAX_RELAYER_DEPOSIT_LOOK_BACK ? JSON.parse(MAX_RELAYER_DEPOSIT_LOOK_BACK) : {};
    this.sendingRelaysEnabled = SEND_RELAYS === "true";
  }
}
