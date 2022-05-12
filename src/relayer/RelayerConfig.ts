import { BigNumber, toBNWei } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
export class RelayerConfig extends CommonConfig {
  readonly relayerDiscount: BigNumber;
  readonly maxRelayerLookBack: { [chainId: number]: number };

  constructor(env: ProcessEnv) {
    const { RELAYER_DISCOUNT, MAX_RELAYER_DEPOSIT_LOOK_BACK } = env;
    super(env);
    this.relayerDiscount = RELAYER_DISCOUNT ? toBNWei(RELAYER_DISCOUNT) : toBNWei(0);
    this.maxRelayerLookBack = MAX_RELAYER_DEPOSIT_LOOK_BACK ? JSON.parse(MAX_RELAYER_DEPOSIT_LOOK_BACK) : {};
  }
}
