import winston from "winston";
import { DEFAULT_MULTICALL_CHUNK_SIZE, DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE, DEFAULT_ARWEAVE_GATEWAY } from "../common";
import { ArweaveGatewayInterface, ArweaveGatewayInterfaceSS } from "../interfaces";
import { assert, CHAIN_IDs, ethers, isDefined } from "../utils";
import * as Constants from "./Constants";

export interface ProcessEnv {
  [key: string]: string | undefined;
}

export class CommonConfig {
  readonly hubPoolChainId: number;
  readonly pollingDelay: number;
  readonly ignoredAddresses: string[];
  readonly maxBlockLookBack: { [key: number]: number };
  readonly maxTxWait: number;
  readonly spokePoolChainsOverride: number[];
  readonly sendingTransactionsEnabled: boolean;
  readonly maxRelayerLookBack: number;
  readonly version: string;
  readonly maxConfigVersion: number;
  readonly blockRangeEndBlockBuffer: { [chainId: number]: number };
  readonly timeToCache: number;
  readonly arweaveGateway: ArweaveGatewayInterface;

  // State we'll load after we update the config store client and fetch all chains we want to support.
  public multiCallChunkSize: { [chainId: number]: number } = {};
  public toBlockOverride: Record<number, number> = {};

  constructor(env: ProcessEnv) {
    const {
      MAX_RELAYER_DEPOSIT_LOOK_BACK,
      BLOCK_RANGE_END_BLOCK_BUFFER,
      IGNORED_ADDRESSES,
      HUB_CHAIN_ID,
      POLLING_DELAY,
      MAX_BLOCK_LOOK_BACK,
      MAX_TX_WAIT_DURATION,
      SEND_TRANSACTIONS,
      SPOKE_POOL_CHAINS_OVERRIDE,
      ACROSS_BOT_VERSION,
      ACROSS_MAX_CONFIG_VERSION,
      HUB_POOL_TIME_TO_CACHE,
      ARWEAVE_GATEWAY,
    } = env;

    this.version = ACROSS_BOT_VERSION ?? "unknown";

    this.timeToCache = Number(HUB_POOL_TIME_TO_CACHE ?? 60 * 60); // 1 hour by default.
    if (Number.isNaN(this.timeToCache) || this.timeToCache < 0) {
      throw new Error("Invalid default caching safe lag");
    }

    // Maximum version of the Across ConfigStore version that is supported.
    // Operators should normally use the defaults here, but it can be overridden for testing.
    // Warning: Possible loss of funds if this is misconfigured.
    this.maxConfigVersion = Number(ACROSS_MAX_CONFIG_VERSION ?? Constants.CONFIG_STORE_VERSION);
    assert(!isNaN(this.maxConfigVersion), `Invalid maximum config version: ${this.maxConfigVersion}`);

    this.blockRangeEndBlockBuffer = BLOCK_RANGE_END_BLOCK_BUFFER
      ? JSON.parse(BLOCK_RANGE_END_BLOCK_BUFFER)
      : Constants.BUNDLE_END_BLOCK_BUFFERS;

    this.ignoredAddresses = JSON.parse(IGNORED_ADDRESSES ?? "[]").map((address) => ethers.utils.getAddress(address));

    // `maxRelayerLookBack` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxRelayerLookBack = Number(MAX_RELAYER_DEPOSIT_LOOK_BACK ?? Constants.MAX_RELAYER_DEPOSIT_LOOK_BACK);
    this.hubPoolChainId = Number(HUB_CHAIN_ID ?? CHAIN_IDs.MAINNET);
    this.pollingDelay = Number(POLLING_DELAY ?? 60);
    this.spokePoolChainsOverride = SPOKE_POOL_CHAINS_OVERRIDE ? JSON.parse(SPOKE_POOL_CHAINS_OVERRIDE) : [];
    this.maxBlockLookBack = MAX_BLOCK_LOOK_BACK ? JSON.parse(MAX_BLOCK_LOOK_BACK) : {};
    if (Object.keys(this.maxBlockLookBack).length === 0) {
      this.maxBlockLookBack = Constants.CHAIN_MAX_BLOCK_LOOKBACK;
    }
    this.maxTxWait = Number(MAX_TX_WAIT_DURATION ?? 180); // 3 minutes
    this.sendingTransactionsEnabled = SEND_TRANSACTIONS === "true";

    // Load the Arweave gateway from the environment.
    const _arweaveGateway = isDefined(ARWEAVE_GATEWAY) ? JSON.parse(ARWEAVE_GATEWAY ?? "{}") : DEFAULT_ARWEAVE_GATEWAY;
    assert(ArweaveGatewayInterfaceSS.is(_arweaveGateway), "Invalid Arweave gateway");
    this.arweaveGateway = _arweaveGateway;
  }

  /**
   * @notice Loads additional configuration state that can only be known after we know all chains that we're going to
   * support. Throws an error if any of the configurations are not valid.
   * @dev This should be called by passing in the latest chain ID indices from an updated ConfigStoreClient.
   * @throws If blockRangeEndBuffer doesn't include a key for each chain ID
   * @throws If maxBlockLookBack doesn't include a key for each chain ID
   * @throws If overridden MULTICALL_CHUNK_SIZE_CHAIN_${chainId} isn't greater than 0
   * @throws If overridden TO_BLOCK_OVERRIDE_${chainId} isn't greater than 0
   * @param chainIdIndices All expected chain ID's that could be supported by this config.
   */
  validate(chainIds: number[], logger: winston.Logger): void {
    const { blockRangeEndBlockBuffer, maxBlockLookBack } = this;

    // Warn about any missing MAX_BLOCK_LOOK_BACK config.
    if (Object.keys(maxBlockLookBack).length > 0) {
      const lookback = Object.keys(maxBlockLookBack).map(Number);
      const missing = chainIds.find((chainId) => !lookback.includes(chainId));
      if (missing) {
        const message = `Missing MAX_BLOCK_LOOK_BACK configuration for chainId ${missing}`;
        logger.warn({ at: "RelayerConfig::validate", message });
        maxBlockLookBack[missing] = 5000; // Revert to a safe default.
      }
    }

    // BLOCK_RANGE_END_BLOCK_BUFFER is important for the dataworker, so assert on it.
    if (Object.keys(blockRangeEndBlockBuffer).length > 0) {
      const buffer = Object.keys(blockRangeEndBlockBuffer).map(Number);
      const missing = chainIds.find((chainId) => !buffer.includes(chainId));
      assert(!missing, `Missing BLOCK_RANGE_END_BLOCK_BUFFER configuration for chainId ${missing}`);
    }

    for (const chainId of chainIds) {
      // Multicall chunk size precedence: Environment, chain-specific config, global default.
      // prettier-ignore
      const chunkSize = Number(
      process.env[`MULTICALL_CHUNK_SIZE_CHAIN_${chainId}`]
        ?? process.env.MULTICALL_CHUNK_SIZE
        ?? DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE[chainId]
        ?? DEFAULT_MULTICALL_CHUNK_SIZE
      );
      assert(chunkSize > 0, `Chain ${chainId} multicall chunk size (${chunkSize}) must be greater than 0`);
      this.multiCallChunkSize[chainId] = chunkSize;

      // Load any toBlock overrides.
      const toBlock = Number(process.env[`TO_BLOCK_OVERRIDE_${chainId}`]) || undefined;
      if (isDefined(toBlock)) {
        assert(toBlock > 0, `TO_BLOCK_OVERRIDE_${chainId} must be greater than 0`);
        this.toBlockOverride[chainId] = toBlock;
      }
    }
  }
}
