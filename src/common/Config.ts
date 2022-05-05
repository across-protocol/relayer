import { assert } from "../utils";
import * as Constants from "./Constants";

export interface ProcessEnv {
  [key: string]: string | undefined;
}

export class CommonConfig {
  readonly hubPoolChainId: number;
  readonly spokePoolChains: number[];
  readonly pollingDelay: number;
  readonly maxBlockLookBack: { [key: number]: number };
  readonly nodeQuorumThreshold: number;

  constructor(env: ProcessEnv) {
    const { CONFIGURED_NETWORKS, HUB_CHAIN_ID, POLLING_DELAY, MAX_BLOCK_LOOK_BACK, NODE_QUORUM_THRESHOLD } = env;
    this.hubPoolChainId = HUB_CHAIN_ID ? Number(HUB_CHAIN_ID) : 1;
    this.spokePoolChains = CONFIGURED_NETWORKS ? JSON.parse(CONFIGURED_NETWORKS) : Constants.CHAIN_ID_LIST_INDICES;
    this.pollingDelay = POLLING_DELAY ? Number(POLLING_DELAY) : 60;
    this.maxBlockLookBack = MAX_BLOCK_LOOK_BACK ? JSON.parse(MAX_BLOCK_LOOK_BACK) : {};
    if (Object.keys(this.maxBlockLookBack).length > 0)
      for (const key of Object.keys(this.maxBlockLookBack))
        assert(this.spokePoolChains.includes(Number(key)), "MAX_BLOCK_LOOK_BACK does not contain all networks");
    else this.maxBlockLookBack = Constants.CHAIN_MAX_BLOCK_LOOKBACK;
    this.nodeQuorumThreshold = NODE_QUORUM_THRESHOLD ? Number(NODE_QUORUM_THRESHOLD) : 1;
  }
}
