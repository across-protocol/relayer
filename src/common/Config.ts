import { assert, BigNumber, toBNWei } from "../utils";
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
  readonly maxTxWait: number;
  readonly sendingTransactionsEnabled: boolean;
  readonly redisUrl: string | undefined;

  constructor(env: ProcessEnv) {
    const {
      CONFIGURED_NETWORKS,
      HUB_CHAIN_ID,
      POLLING_DELAY,
      MAX_BLOCK_LOOK_BACK,
      NODE_QUORUM_THRESHOLD,
      MAX_TX_WAIT_DURATION,
      SEND_TRANSACTIONS,
      REDIS_URL,
    } = env;
    this.hubPoolChainId = HUB_CHAIN_ID ? Number(HUB_CHAIN_ID) : 1;
    this.spokePoolChains = CONFIGURED_NETWORKS ? JSON.parse(CONFIGURED_NETWORKS) : Constants.CHAIN_ID_LIST_INDICES;
    this.pollingDelay = POLLING_DELAY ? Number(POLLING_DELAY) : 60;
    this.maxBlockLookBack = MAX_BLOCK_LOOK_BACK ? JSON.parse(MAX_BLOCK_LOOK_BACK) : {};
    if (Object.keys(this.maxBlockLookBack).length > 0)
      for (const chainId of this.spokePoolChains)
        assert(Object.keys(this.maxBlockLookBack).includes(chainId.toString()), "MAX_BLOCK_LOOK_BACK missing networks");
    else this.maxBlockLookBack = Constants.CHAIN_MAX_BLOCK_LOOKBACK;
    this.nodeQuorumThreshold = NODE_QUORUM_THRESHOLD ? Number(NODE_QUORUM_THRESHOLD) : 1;
    this.maxTxWait = MAX_TX_WAIT_DURATION ? Number(MAX_TX_WAIT_DURATION) : 180; // 3 minutes
    this.sendingTransactionsEnabled = SEND_TRANSACTIONS === "true";
    this.redisUrl = REDIS_URL;
  }
}
