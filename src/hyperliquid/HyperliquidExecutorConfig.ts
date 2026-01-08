import { toBNWei, BigNumber } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";

export class HyperliquidExecutorConfig extends CommonConfig {
  public readonly supportedTokens: string[];
  public readonly lookback: number;
  public readonly reviewInterval: number;
  public readonly maxSlippageBps: BigNumber;
  public readonly settlementInterval: number;

  constructor(env: ProcessEnv) {
    super(env);

    const {
      HYPERLIQUID_SUPPORTED_TOKENS,
      HL_DEPOSIT_LOOKBACK,
      HYPERLIQUID_REPLACE_ORDER_BLOCK_TIMEOUT,
      MAX_SLIPPAGE_BPS,
      HYPERLIQUID_SETTLEMENT_INTERVAL = 5, // blocks
    } = env;
    this.supportedTokens = JSON.parse(HYPERLIQUID_SUPPORTED_TOKENS ?? "[]");
    this.lookback = Number(HL_DEPOSIT_LOOKBACK ?? 3600);
    this.reviewInterval = Number(HYPERLIQUID_REPLACE_ORDER_BLOCK_TIMEOUT ?? 20);
    this.maxSlippageBps = toBNWei(Number(MAX_SLIPPAGE_BPS ?? 5), 4); // With 8 decimal precision, a basis point is 10000. Default to 5bps.
    this.settlementInterval = Number(HYPERLIQUID_SETTLEMENT_INTERVAL);
  }
}
