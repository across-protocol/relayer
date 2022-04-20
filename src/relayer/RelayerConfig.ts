import { ethers } from "ethers";
import assert from "assert";

export interface ProcessEnv {
  [key: string]: string | undefined;
}

export class RelayerConfig {
  readonly hubPoolChainId: number;
  readonly spokePoolChains: number[];
  readonly pollingDelay: number;
  readonly maxBlockLookBack: { [key: number]: number };
  readonly nodeQuorumThreshold: number;

  constructor(env: ProcessEnv) {
    const { CONFIGURED_NETWORKS, HUB_CHAIN_ID, POLLING_DELAY, MAX_BLOCK_LOOK_BACK, NODE_QUORUM_THRESHOLD } = env;
    assert(CONFIGURED_NETWORKS, "CONFIGURED_NETWORKS required");
    this.hubPoolChainId = HUB_CHAIN_ID ? Number(HUB_CHAIN_ID) : 1;
    this.spokePoolChains = CONFIGURED_NETWORKS ? JSON.parse(CONFIGURED_NETWORKS) : [1, 10, 42161, 288];
    this.pollingDelay = POLLING_DELAY ? Number(POLLING_DELAY) : 60;
    this.maxBlockLookBack = MAX_BLOCK_LOOK_BACK ? JSON.parse(MAX_BLOCK_LOOK_BACK) : {};
    if (this.maxBlockLookBack != {})
      for (const key of Object.keys(this.maxBlockLookBack))
        assert(this.spokePoolChains.includes(Number(key)), "MAX_BLOCK_LOOK_BACK does not contain all networks");
    else this.maxBlockLookBack = { 1: 0, 10: 0, 42161: 99990, 288: 99990 }; // Optimism, ethereum can do infinity lookbacks. boba and Aribtrum limited to 100000 on infura.
    this.nodeQuorumThreshold = NODE_QUORUM_THRESHOLD ? Number(NODE_QUORUM_THRESHOLD) : 1;
  }
}
