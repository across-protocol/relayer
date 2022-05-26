import { ProcessEnv } from "../common";
import { RelayerConfig } from "../relayer/RelayerConfig";
import * as Constants from "../common/Constants";

export class FinalizerConfig extends RelayerConfig {
  readonly finalizerChains: number[];
  readonly finalizerEnabled: boolean;

  constructor(env: ProcessEnv) {
    super(env);
    const { FINALIZER_CHAINS, FINALIZER_ENABLED } = env;
    this.finalizerChains = FINALIZER_CHAINS ? JSON.parse(FINALIZER_CHAINS) : Constants.CHAIN_ID_LIST_INDICES;
    this.finalizerEnabled = FINALIZER_ENABLED === "true";
  }
}
