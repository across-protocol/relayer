import assert from "assert";
import { CommonConfig, ProcessEnv } from "../common";
import { isDefined, parseJson } from "../utils";

/**
 * Allowed pegged token pairs for gasless deposits/fills. Same shape as PEGGED_TOKEN_PRICES:
 * { "USDT": ["USDC"] } means input token USDT(0) may have output token USDC.
 * Keys and values are L1 token symbols (from TOKEN_SYMBOLS_MAP / getTokenInfo on L1 address).
 */
export type AllowedPeggedPairs = { [inputSymbol: string]: Set<string> };

export class GaslessRelayerConfig extends CommonConfig {
  apiPollingInterval: number;
  apiEndpoint: string;
  swapApiKey: string;

  relayerOriginChains: number[];
  relayerDestinationChains: number[];
  relayerTokenSymbols: string[];
  depositLookback: number;
  apiTimeoutOverride: number;
  initializationRetryAttempts: number;
  /** When true, allow deposits with inputAmount < outputAmount and outputAmount === MAX_UINT_VAL (refund-flow test); deposit is made but fill is skipped. */
  refundFlowTestEnabled: boolean;
  spokePoolPeripheryOverrides: { [chainId: number]: string };
  /** Gasless-only: allowed input→output token pairs (by L1 symbol). E.g. { "USDT": ["USDC"] }. */
  allowedPeggedPairs: AllowedPeggedPairs;
  /**
   * Origin chain IDs where canonical Permit2 is not used (skip loading and nonce-bitmap reads).
   * JSON array of numbers, e.g. `[999]` for HyperEVM. Default `[]`.
   */
  noPermit2ContractChainIds: Set<number>;

  constructor(env: ProcessEnv) {
    super(env);

    const {
      API_POLLING_INTERVAL,
      API_GASLESS_ENDPOINT,
      MAX_RELAYER_DEPOSIT_LOOKBACK,
      RELAYER_ORIGIN_CHAINS,
      RELAYER_DESTINATION_CHAINS,
      RELAYER_TOKEN_SYMBOLS,
      API_TIMEOUT_OVERRIDE,
      INITIALIZATION_RETRY_ATTEMPTS,
      RELAYER_GASLESS_REFUND_FLOW_TEST_ENABLED,
      SPOKE_POOL_PERIPHERY_OVERRIDES,
      GASLESS_ALLOWED_PEGGED_PAIRS,
      SWAP_API_KEY,
      NO_PERMIT2_CONTRACT_CHAINS,
    } = env;
    this.apiPollingInterval = Number(API_POLLING_INTERVAL ?? 1); // Default to 1s
    this.apiEndpoint = String(API_GASLESS_ENDPOINT);

    this.swapApiKey = SWAP_API_KEY?.trim() ?? "";

    const relayerOriginChains = new Set(parseJson.numberArray(RELAYER_ORIGIN_CHAINS));
    this.relayerOriginChains = Array.from(relayerOriginChains);
    const relayerDestinationChains = new Set(parseJson.numberArray(RELAYER_DESTINATION_CHAINS));
    this.relayerDestinationChains = Array.from(relayerDestinationChains);

    assert(isDefined(RELAYER_TOKEN_SYMBOLS), "RELAYER_TOKEN_SYMBOLS must be defined");
    this.relayerTokenSymbols = parseJson.stringArray(RELAYER_TOKEN_SYMBOLS);
    this.depositLookback = Number(MAX_RELAYER_DEPOSIT_LOOKBACK ?? 3600);

    this.apiTimeoutOverride = Number(API_TIMEOUT_OVERRIDE ?? 3000); // In ms
    this.initializationRetryAttempts = Number(INITIALIZATION_RETRY_ATTEMPTS ?? 3);
    this.refundFlowTestEnabled = String(RELAYER_GASLESS_REFUND_FLOW_TEST_ENABLED ?? "").toLowerCase() === "true";

    this.spokePoolPeripheryOverrides = parseJson.stringMap(SPOKE_POOL_PERIPHERY_OVERRIDES);

    this.allowedPeggedPairs = Object.fromEntries(
      Object.entries(parseJson.stringArrayMap(GASLESS_ALLOWED_PEGGED_PAIRS)).map(([inputSymbol, outputSymbols]) => [
        inputSymbol,
        new Set(outputSymbols),
      ])
    );

    this.noPermit2ContractChainIds = new Set(parseJson.numberArray(NO_PERMIT2_CONTRACT_CHAINS ?? "[]"));
  }
}
