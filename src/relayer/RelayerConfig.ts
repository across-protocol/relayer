import { ethers } from "ethers";
import assert from "assert";

export interface ProcessEnv {
  [key: string]: string | undefined;
}

export class RelayerConfig {
  readonly hubPoolChainId: number;
  readonly spokePoolChains: number[];
  readonly pollingDelay: number;

  constructor(env: ProcessEnv) {
    const { CONFIGURED_NETWORKS, HUB_CHAIN_ID, POLLING_DELAY } = env;
    assert(CONFIGURED_NETWORKS, "HUB_POOL_ADDRESS required");
    this.hubPoolChainId = HUB_CHAIN_ID ? Number(HUB_CHAIN_ID) : 1;

    this.spokePoolChains = CONFIGURED_NETWORKS ? JSON.parse(CONFIGURED_NETWORKS) : [1, 10, 42161, 288];

    this.pollingDelay = POLLING_DELAY ? Number(POLLING_DELAY) : 60;
  }
}
