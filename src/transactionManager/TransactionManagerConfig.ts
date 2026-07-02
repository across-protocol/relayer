import { CommonConfig, ProcessEnv } from "../common";

export class TransactionManagerConfig extends CommonConfig {
  readonly chainId: number;
  readonly confirmationTimeoutMs?: number;

  constructor(env: ProcessEnv, eoa: string) {
    super(env, { botIdentifier: `across-transaction-manager-${eoa.toLowerCase()}` });

    const { TXN_MANAGER_CHAIN_ID, TXN_MANAGER_CONFIRMATION_TIMEOUT_MS } = env;
    if (!TXN_MANAGER_CHAIN_ID) {
      throw new Error("TXN_MANAGER_CHAIN_ID env var must be set");
    }
    const chainId = Number(TXN_MANAGER_CHAIN_ID);
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new Error(`Invalid TXN_MANAGER_CHAIN_ID: ${TXN_MANAGER_CHAIN_ID}`);
    }
    this.chainId = chainId;

    if (TXN_MANAGER_CONFIRMATION_TIMEOUT_MS) {
      const ms = Number(TXN_MANAGER_CONFIRMATION_TIMEOUT_MS);
      if (!Number.isInteger(ms) || ms <= 0) {
        throw new Error(`Invalid TXN_MANAGER_CONFIRMATION_TIMEOUT_MS: ${TXN_MANAGER_CONFIRMATION_TIMEOUT_MS}`);
      }
      this.confirmationTimeoutMs = ms;
    }
  }
}
