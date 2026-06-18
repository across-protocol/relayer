import { CommonConfig, ProcessEnv } from "../common";
import { parseJson } from "../utils";

export class DepositAddressHandlerConfig extends CommonConfig {
  indexerApiEndpoint: string;
  indexerPollingInterval: number;

  relayerOriginChains: number[];
  depositLookback: number;
  apiTimeoutOverride: number;
  initializationRetryAttempts: number;
  swapApiKey: string;
  withdrawEnabled: boolean;
  /** Gate for the v3 (upgradeable-counterfactual) refund-withdraw path. Independent of withdrawEnabled. */
  enableV3Withdrawals: boolean;

  /** Gate for publishing `withdraw_executed` events to GCP Pub/Sub. */
  enableDepositAddressWithdrawPublisher: boolean;
  /** GCP project that hosts the withdraw-lifecycle topic. Required when the publisher gate is on. */
  pubSubGcpProjectId: string;
  /** Short topic name (e.g. `topic-deposit-address-withdraw`). Required when the publisher gate is on. */
  pubSubDepositAddressWithdrawTopic: string;

  constructor(env: ProcessEnv) {
    super(env, { botIdentifier: "across-deposit-address-handler" });

    const {
      INDEXER_API_POLLING_INTERVAL,
      INDEXER_API_ENDPOINT,
      MAX_RELAYER_DEPOSIT_LOOKBACK,
      RELAYER_ORIGIN_CHAINS,
      API_TIMEOUT_OVERRIDE,
      SWAP_API_KEY,
      INITIALIZATION_RETRY_ATTEMPTS,
      WITHDRAW_ENABLED,
      ENABLE_V3_WITHDRAWALS,
      ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER,
      PUBSUB_GCP_PROJECT_ID,
      PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC,
    } = env;
    this.indexerPollingInterval = Number(INDEXER_API_POLLING_INTERVAL ?? 1); // Default to 1s
    this.indexerApiEndpoint = String(INDEXER_API_ENDPOINT);
    this.swapApiKey = SWAP_API_KEY?.trim() ?? "";
    if (!this.swapApiKey) {
      throw new Error("SWAP_API_KEY is required (set SWAP_API_KEY in env)");
    }

    const relayerOriginChains = new Set(parseJson.numberArray(RELAYER_ORIGIN_CHAINS));
    this.relayerOriginChains = Array.from(relayerOriginChains);

    this.depositLookback = Number(MAX_RELAYER_DEPOSIT_LOOKBACK ?? 3600);

    this.apiTimeoutOverride = Number(API_TIMEOUT_OVERRIDE ?? 3000); // In ms
    this.initializationRetryAttempts = Number(INITIALIZATION_RETRY_ATTEMPTS ?? 3);
    this.withdrawEnabled = WITHDRAW_ENABLED === "true";
    this.enableV3Withdrawals = ENABLE_V3_WITHDRAWALS === "true";

    this.enableDepositAddressWithdrawPublisher = ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER === "true";
    this.pubSubGcpProjectId = PUBSUB_GCP_PROJECT_ID?.trim() ?? "";
    this.pubSubDepositAddressWithdrawTopic = PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC?.trim() ?? "";
    if (this.enableDepositAddressWithdrawPublisher) {
      if (!this.pubSubGcpProjectId) {
        throw new Error("PUBSUB_GCP_PROJECT_ID is required when ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER=true");
      }
      if (!this.pubSubDepositAddressWithdrawTopic) {
        throw new Error(
          "PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC is required when ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER=true"
        );
      }
    }
  }
}
