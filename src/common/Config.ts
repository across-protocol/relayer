import { DEFAULT_MULTICALL_CHUNK_SIZE, DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE } from "../common";
import { assert } from "../utils";
import * as Constants from "./Constants";

export interface ProcessEnv {
  [key: string]: string | undefined;
}

export class CommonConfig {
  readonly hubPoolChainId: number;
  readonly pollingDelay: number;
  readonly maxBlockLookBack: { [key: number]: number };
  readonly maxTxWait: number;
  readonly spokePoolChainsOverride: number[];
  readonly sendingTransactionsEnabled: boolean;
  readonly bundleRefundLookback: number;
  readonly maxRelayerLookBack: number;
  readonly multiCallChunkSize: { [chainId: number]: number };
  readonly version: string;
  readonly maxConfigVersion: number;
  readonly blockRangeEndBlockBuffer: { [chainId: number]: number };
  readonly toBlockOverride: Record<number, number> = {};

  constructor(env: ProcessEnv) {
    const {
      MAX_RELAYER_DEPOSIT_LOOK_BACK,
      BLOCK_RANGE_END_BLOCK_BUFFER,
      HUB_CHAIN_ID,
      POLLING_DELAY,
      MAX_BLOCK_LOOK_BACK,
      MAX_TX_WAIT_DURATION,
      SEND_TRANSACTIONS,
      BUNDLE_REFUND_LOOKBACK,
      SPOKE_POOL_CHAINS_OVERRIDE,
      ACROSS_BOT_VERSION,
      ACROSS_MAX_CONFIG_VERSION,
    } = env;

    this.version = ACROSS_BOT_VERSION ?? "unknown";

    // Maximum version of the Across ConfigStore version that is supported.
    // Operators should normally use the defaults here, but it can be overridden for testing.
    // Warning: Possible loss of funds if this is misconfigured.
    this.maxConfigVersion = Number(ACROSS_MAX_CONFIG_VERSION ?? Constants.CONFIG_STORE_VERSION);
    assert(!isNaN(this.maxConfigVersion), `Invalid maximum config version: ${this.maxConfigVersion}`);

    this.blockRangeEndBlockBuffer = BLOCK_RANGE_END_BLOCK_BUFFER
      ? JSON.parse(BLOCK_RANGE_END_BLOCK_BUFFER)
      : Constants.BUNDLE_END_BLOCK_BUFFERS;
          "BLOCK_RANGE_END_BLOCK_BUFFER missing networks"

    // Min deposit confirmations seems like the most likely constant to have all possible chain IDs listed.
    const allPossibleChainIds = Object.keys(Constants.MIN_DEPOSIT_CONFIRMATIONS).map((chainId) => Number(chainId));

    for (const chainId of allPossibleChainIds) {
      if (env[`TO_BLOCK_OVERRIDE_${chainId}`] !== undefined) {
        const toBlock = Number(env[`TO_BLOCK_OVERRIDE_${chainId}`]);
        assert(toBlock > 0, `TO_BLOCK_OVERRIDE_${chainId} must be greater than 0`);
        this.toBlockOverride[chainId] = toBlock;
      }
    }

    // `maxRelayerLookBack` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxRelayerLookBack = Number(MAX_RELAYER_DEPOSIT_LOOK_BACK ?? Constants.MAX_RELAYER_DEPOSIT_LOOK_BACK);
    this.hubPoolChainId = Number(HUB_CHAIN_ID ?? 1);
    this.pollingDelay = Number(POLLING_DELAY ?? 60);
    this.spokePoolChainsOverride = SPOKE_POOL_CHAINS_OVERRIDE ? JSON.parse(SPOKE_POOL_CHAINS_OVERRIDE) : [];
    this.maxBlockLookBack = MAX_BLOCK_LOOK_BACK ? JSON.parse(MAX_BLOCK_LOOK_BACK) : {};
    if (Object.keys(this.maxBlockLookBack).length === 0) {
      this.maxBlockLookBack = Constants.CHAIN_MAX_BLOCK_LOOKBACK;
    }
    this.maxTxWait = Number(MAX_TX_WAIT_DURATION ?? 180); // 3 minutes
    this.sendingTransactionsEnabled = SEND_TRANSACTIONS === "true";
    this.bundleRefundLookback = Number(BUNDLE_REFUND_LOOKBACK ?? 2);

    // Multicall chunk size precedence: Environment, chain-specific config, global default.
    this.multiCallChunkSize = Object.fromEntries(
      allPossibleChainIds.map((_chainId) => {
        const chainId = Number(_chainId);
        // prettier-ignore
        const chunkSize = Number(
          process.env[`MULTICALL_CHUNK_SIZE_CHAIN_${chainId}`]
            ?? DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE[chainId]
            ?? DEFAULT_MULTICALL_CHUNK_SIZE
        );
        assert(chunkSize > 0, `Chain ${chainId} multicall chunk size (${chunkSize}) must be greater than 0`);
        return [chainId, chunkSize];
      })
    );
  }
}
