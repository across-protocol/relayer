import { CommonConfig, ProcessEnv } from "../common";

export class HyperliquidExecutorConfig extends CommonConfig {
  public readonly supportedTokens: string[];
  public readonly lookback: number;
  public readonly reviewInterval: number;

  constructor(env: ProcessEnv) {
    super(env);

    const { HYPERLIQUID_SUPPORTED_TOKENS, HL_DEPOSIT_LOOKBACK, HYPERLIQUID_REPLACE_ORDER_BLOCK_TIMEOUT } = env;
    this.supportedTokens = JSON.parse(HYPERLIQUID_SUPPORTED_TOKENS ?? "[]");
    this.lookback = Number(HL_DEPOSIT_LOOKBACK ?? 3600);
    this.reviewInterval = Number(HYPERLIQUID_REPLACE_ORDER_BLOCK_TIMEOUT ?? 20);
  }
}
