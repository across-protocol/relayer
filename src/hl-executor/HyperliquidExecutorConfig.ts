import { CommonConfig, ProcessEnv } from "../common";

export class HyperliquidExecutorConfig extends CommonConfig {
  public readonly supportedTokens: string[];

  constructor(env: ProcessEnv) {
    super(env);

    const { HYPERLIQUID_SUPPORTED_TOKENS } = env;
    this.supportedTokens = JSON.parse(HYPERLIQUID_SUPPORTED_TOKENS ?? "[]");
  }
}
