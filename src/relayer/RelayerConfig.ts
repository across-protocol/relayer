import { BigNumber, assert, toBNWei } from "../utils";

export interface ProcessEnv {
  [key: string]: string | undefined;
}

export class RelayerConfig {
  readonly hubPoolChainId: number;
  readonly spokePoolChains: number[];
  readonly pollingDelay: number;
  readonly relayerDiscount: BigNumber;

  constructor(env: ProcessEnv) {
    const { CONFIGURED_NETWORKS, HUB_CHAIN_ID, POLLING_DELAY, RELAYER_DISCOUNT } = env;
    assert(CONFIGURED_NETWORKS, "HUB_POOL_ADDRESS required");
    this.hubPoolChainId = HUB_CHAIN_ID ? Number(HUB_CHAIN_ID) : 1;
    this.spokePoolChains = CONFIGURED_NETWORKS ? JSON.parse(CONFIGURED_NETWORKS) : [1, 10, 42161, 288];
    this.pollingDelay = POLLING_DELAY ? Number(POLLING_DELAY) : 60;
    this.relayerDiscount = RELAYER_DISCOUNT ? toBNWei(RELAYER_DISCOUNT) : toBNWei(0);
  }
}
