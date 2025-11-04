import { CommonConfig, ProcessEnv } from "../common";

export class HyperliquidBotConfig extends CommonConfig {
  public readonly supportedTokens: string[];
  public readonly depositLookback: number;

  constructor(env: ProcessEnv) {
    super(env);

    const { HYPERLIQUID_SUPPORTED_TOKENS, HYPERLIQUID_DEPOSIT_LOOKBACK } = env;
    this.supportedTokens = JSON.parse(HYPERLIQUID_SUPPORTED_TOKENS ?? "[]");
    this.depositLookback = Number(HYPERLIQUID_DEPOSIT_LOOKBACK ?? 7200);
  }
}
