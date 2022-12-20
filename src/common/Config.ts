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
  readonly maxTxWait: number;
  readonly sendingTransactionsEnabled: boolean;
  readonly redisUrl: string | undefined;
  readonly bundleRefundLookback: number;
  readonly maxRelayerLookBack: number;
  readonly maxRelayerUnfilledDepositLookBack: number;
  readonly version: string;

  constructor(env: ProcessEnv) {
    const {
      MAX_RELAYER_DEPOSIT_LOOK_BACK,
      CONFIGURED_NETWORKS,
      HUB_CHAIN_ID,
      POLLING_DELAY,
      MAX_BLOCK_LOOK_BACK,
      MAX_TX_WAIT_DURATION,
      SEND_TRANSACTIONS,
      REDIS_URL,
      BUNDLE_REFUND_LOOKBACK,
      ACROSS_BOT_VERSION,
    } = env;

    this.version = ACROSS_BOT_VERSION ?? "unknown";

    // `maxRelayerLookBack` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxRelayerLookBack = MAX_RELAYER_DEPOSIT_LOOK_BACK
      ? Number(MAX_RELAYER_DEPOSIT_LOOK_BACK)
      : Constants.MAX_RELAYER_DEPOSIT_LOOK_BACK;

    // `maxRelayerUnfilledDepositLookBack` informs relayer to ignore any unfilled deposits older than this amount of
    // of blocks from latest. This allows us to ignore any false positive unfilled deposits that occur because of how
    // `maxRelayerLookBack` is set. This can happen because block lookback per chain is not exactly equal to the same
    // amount of time looking back on the chains, so you might produce some deposits that look like they weren't filled.
    this.maxRelayerUnfilledDepositLookBack = this.maxRelayerLookBack / 4; // TODO: Allow caller
    // to modify what we divide `maxRelayerLookBack` values by.
    this.hubPoolChainId = HUB_CHAIN_ID ? Number(HUB_CHAIN_ID) : 1;
    this.spokePoolChains = CONFIGURED_NETWORKS ? JSON.parse(CONFIGURED_NETWORKS) : Constants.CHAIN_ID_LIST_INDICES;
    this.pollingDelay = POLLING_DELAY ? Number(POLLING_DELAY) : 60;
    this.maxBlockLookBack = MAX_BLOCK_LOOK_BACK ? JSON.parse(MAX_BLOCK_LOOK_BACK) : {};
    if (Object.keys(this.maxBlockLookBack).length > 0)
      for (const chainId of this.spokePoolChains)
        assert(Object.keys(this.maxBlockLookBack).includes(chainId.toString()), "MAX_BLOCK_LOOK_BACK missing networks");
    else this.maxBlockLookBack = Constants.CHAIN_MAX_BLOCK_LOOKBACK;
    this.maxTxWait = MAX_TX_WAIT_DURATION ? Number(MAX_TX_WAIT_DURATION) : 180; // 3 minutes
    this.sendingTransactionsEnabled = SEND_TRANSACTIONS === "true";
    this.redisUrl = REDIS_URL;
    this.bundleRefundLookback = BUNDLE_REFUND_LOOKBACK ? Number(BUNDLE_REFUND_LOOKBACK) : 2;
  }
}
