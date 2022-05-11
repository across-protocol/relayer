import { BigNumber, toBNWei } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
export class RelayerConfig extends CommonConfig {
  readonly relayerDiscount: BigNumber;
  readonly maxRelayerLookBack: number;

  constructor(env: ProcessEnv) {
    const { RELAYER_DISCOUNT, MAX_RELAYER_LOOK_BACK } = env;
    super(env);
    this.relayerDiscount = RELAYER_DISCOUNT ? toBNWei(RELAYER_DISCOUNT) : toBNWei(0);
    this.maxRelayerLookBack = MAX_RELAYER_LOOK_BACK ? Number(MAX_RELAYER_LOOK_BACK) : 0;
  }
}
