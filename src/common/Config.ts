import { DEFAULT_MULTICALL_CHUNK_SIZE, DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE } from "../common";
import { filterDisabledChains } from "../dataworker/DataworkerUtils";
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
  readonly maxTxWait: number;
  readonly sendingTransactionsEnabled: boolean;
  readonly redisUrl: string | undefined;
  readonly bundleRefundLookback: number;
  readonly maxRelayerLookBack: number;
  readonly multiCallChunkSize: { [chainId: number]: number };
  readonly version: string;
  readonly disabledChainsOverride: number[];
  readonly blockRangeEndBlockBuffer: { [chainId: number]: number };

  constructor(env: ProcessEnv) {
    const {
      MAX_RELAYER_DEPOSIT_LOOK_BACK,
      CONFIGURED_NETWORKS,
      BLOCK_RANGE_END_BLOCK_BUFFER,
      HUB_CHAIN_ID,
      POLLING_DELAY,
      MAX_BLOCK_LOOK_BACK,
      MAX_TX_WAIT_DURATION,
      SEND_TRANSACTIONS,
      REDIS_URL,
      BUNDLE_REFUND_LOOKBACK,
      ACROSS_BOT_VERSION,
      DISABLED_CHAINS_OVERRIDE,
    } = env;

    this.version = ACROSS_BOT_VERSION ?? "unknown";
    this.disabledChainsOverride = DISABLED_CHAINS_OVERRIDE
      ? filterDisabledChains(JSON.parse(DISABLED_CHAINS_OVERRIDE) as number[])
      : [];

    this.blockRangeEndBlockBuffer = BLOCK_RANGE_END_BLOCK_BUFFER
      ? JSON.parse(BLOCK_RANGE_END_BLOCK_BUFFER)
      : Constants.BUNDLE_END_BLOCK_BUFFERS;
    // `maxRelayerLookBack` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxRelayerLookBack = Number(MAX_RELAYER_DEPOSIT_LOOK_BACK ?? Constants.MAX_RELAYER_DEPOSIT_LOOK_BACK);
    this.hubPoolChainId = Number(HUB_CHAIN_ID ?? 1);
    this.pollingDelay = Number(POLLING_DELAY ?? 60);
    this.spokePoolChains = CONFIGURED_NETWORKS ? JSON.parse(CONFIGURED_NETWORKS) : Constants.CHAIN_ID_LIST_INDICES;
    this.maxBlockLookBack = MAX_BLOCK_LOOK_BACK ? JSON.parse(MAX_BLOCK_LOOK_BACK) : {};
    if (Object.keys(this.maxBlockLookBack).length > 0)
      for (const chainId of this.spokePoolChains)
        assert(Object.keys(this.maxBlockLookBack).includes(chainId.toString()), "MAX_BLOCK_LOOK_BACK missing networks");
    else this.maxBlockLookBack = Constants.CHAIN_MAX_BLOCK_LOOKBACK;
    this.maxTxWait = Number(MAX_TX_WAIT_DURATION ?? 180); // 3 minutes
    this.sendingTransactionsEnabled = SEND_TRANSACTIONS === "true";
    this.redisUrl = REDIS_URL;
    this.bundleRefundLookback = Number(BUNDLE_REFUND_LOOKBACK ?? 2);

    // Multicall chunk size precedence: Environment, chain-specific config, global default.
    this.multiCallChunkSize = Object.fromEntries(
      this.spokePoolChains.map((_chainId) => {
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
