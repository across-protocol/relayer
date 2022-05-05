import { BigNumber, toBNWei } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
export class RelayerConfig extends CommonConfig {
  readonly relayerDiscount: BigNumber;

  constructor(env: ProcessEnv) {
    const { RELAYER_DISCOUNT } = env;
    super(env);
    this.relayerDiscount = RELAYER_DISCOUNT ? toBNWei(RELAYER_DISCOUNT) : toBNWei(0);
  }
}
