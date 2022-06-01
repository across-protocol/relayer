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
  readonly relayerDiscount: BigNumber;
  readonly sendingTransactionsEnabled: boolean;

  // Note: maxSpokeClientLookBack is a very dangerous config variable to set because it can unexpectedly produce invalid
  // root bundles if it misses older events. This should only be used in Relayer functions, or carefully in Dataworker
  // functions. For example, if you want to limit the amount of blocks looked back when trying to execute root bundles,
  // then you should also limit the amount of root bundles that you look back by setting the SPOKE_ROOTS_LOOKBACK_COUNT
  // variable to something small. A reasonable setting would be to look back ~48 hours per chain and only 1-2 root
  // bundles per chain, since it is very unlikely that the 2 most recent root bundles will contain events from more
  // than 48 hours into the past.
  readonly maxSpokeClientLookBack: { [chainId: number]: number };

  constructor(env: ProcessEnv) {
    const {
      CONFIGURED_NETWORKS,
      HUB_CHAIN_ID,
      POLLING_DELAY,
      MAX_BLOCK_LOOK_BACK,
      NODE_QUORUM_THRESHOLD,
      MAX_TX_WAIT_DURATION,
      RELAYER_DISCOUNT,
      SEND_TRANSACTIONS,
      MAX_SPOKE_CLIENT_LOOK_BACK,
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
    this.relayerDiscount = RELAYER_DISCOUNT ? toBNWei(RELAYER_DISCOUNT) : toBNWei(0);
    this.sendingTransactionsEnabled = SEND_TRANSACTIONS === "true";
    this.maxSpokeClientLookBack = MAX_SPOKE_CLIENT_LOOK_BACK ? JSON.parse(MAX_SPOKE_CLIENT_LOOK_BACK) : {};
  }
}
