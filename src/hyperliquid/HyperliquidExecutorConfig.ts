import { BigNumber, toBNWei } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";

export class HyperliquidExecutorConfig extends CommonConfig {
  public readonly supportedTokens: string[];
  public readonly lookback: number;
  public readonly reviewInterval: number;
  public readonly maxAllowedSlippage: BigNumber;

  constructor(env: ProcessEnv) {
    super(env);

    const {
      HYPERLIQUID_SUPPORTED_TOKENS,
      HL_DEPOSIT_LOOKBACK,
      HYPERLIQUID_REPLACE_ORDER_BLOCK_TIMEOUT,
      HL_MAX_ALLOWED_SLIPPAGE,
    } = env;
    this.supportedTokens = JSON.parse(HYPERLIQUID_SUPPORTED_TOKENS ?? "[]");
    this.lookback = Number(HL_DEPOSIT_LOOKBACK ?? 3600);
    this.reviewInterval = Number(HYPERLIQUID_REPLACE_ORDER_BLOCK_TIMEOUT ?? 20);
    this.maxAllowedSlippage = toBNWei(Number(HL_MAX_ALLOWED_SLIPPAGE ?? 0.05), 18); // Default is 5% slippage.
  }
}
