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
  readonly maxRelayerLookBack: { [chainId: number]: number };
  readonly maxRelayerUnfilledDepositLookBack: { [chainId: number]: number };
  // Following distances in blocks to guarantee finality on each chain.
  readonly minDepositConfirmations: { [chainId: number]: number };

  constructor(env: ProcessEnv) {
    const {
      MAX_RELAYER_DEPOSIT_LOOK_BACK,
      CONFIGURED_NETWORKS,
      HUB_CHAIN_ID,
      POLLING_DELAY,
      MAX_BLOCK_LOOK_BACK,
      NODE_QUORUM_THRESHOLD,
      MAX_TX_WAIT_DURATION,
      SEND_TRANSACTIONS,
      REDIS_URL,
      BUNDLE_REFUND_LOOKBACK,
      MIN_DEPOSIT_CONFIRMATIONS,
    } = env;

    // `maxRelayerLookBack` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxRelayerLookBack = MAX_RELAYER_DEPOSIT_LOOK_BACK
      ? JSON.parse(MAX_RELAYER_DEPOSIT_LOOK_BACK)
      : Constants.MAX_RELAYER_DEPOSIT_LOOK_BACK;

    // `maxRelayerUnfilledDepositLookBack` informs relayer to ignore any unfilled deposits older than this amount of
    // of blocks from latest. This allows us to ignore any false positive unfilled deposits that occur because of how
    // `maxRelayerLookBack` is set. This can happen because block lookback per chain is not exactly equal to the same
    // amount of time looking back on the chains, so you might produce some deposits that look like they weren't filled.
    this.maxRelayerUnfilledDepositLookBack = { ...this.maxRelayerLookBack };
    Object.keys(this.maxRelayerUnfilledDepositLookBack).forEach((chain) => {
      this.maxRelayerUnfilledDepositLookBack[chain] = Number(this.maxRelayerLookBack[chain]) / 4; // TODO: Allow caller
      // to modify what we divide `maxRelayerLookBack` values by.
    });
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
    this.bundleRefundLookback = BUNDLE_REFUND_LOOKBACK ? Number(BUNDLE_REFUND_LOOKBACK) : 2;
    this.minDepositConfirmations = MIN_DEPOSIT_CONFIRMATIONS
      ? JSON.parse(MIN_DEPOSIT_CONFIRMATIONS)
      : Constants.MIN_DEPOSIT_CONFIRMATIONS;

    this.spokePoolChains.forEach((chainId) => {
      const nBlocks: number = this.minDepositConfirmations[chainId];
      assert(
        !isNaN(nBlocks) && nBlocks >= 0,
        `Chain ${chainId} minimum deposit confirmations missing or invalid (${nBlocks}).`
      );
    });
  }
}
