import { CommonConfig, ProcessEnv } from "../common";
import { parseJson } from "../utils";

export class DepositAddressHandlerConfig extends CommonConfig {
  indexerApiEndpoint: string;
  indexerPollingInterval: number;
  /** Interval in seconds for the background periodic task (placeholder today). */
  periodicTaskInterval: number;

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
  /** Gate for publishing `deposit_executed` events (v3 correct-transfer executions). Independent of the withdraw gate; shares the topic. */
  enableDepositAddressDepositPublisher: boolean;
  /** GCP project that hosts the execution-lifecycle topic. Required when a publisher gate is on. */
  pubSubGcpProjectId: string;
  /** Short topic name (e.g. `topic-deposit-address-execution`); shared by both events. Required when a publisher gate is on. */
  pubSubDepositAddressWithdrawTopic: string;

  constructor(env: ProcessEnv) {
    super(env, { botIdentifier: "across-deposit-address-handler" });

    const {
      INDEXER_API_POLLING_INTERVAL,
      DEPOSIT_ADDRESS_PERIODIC_TASK_INTERVAL,
      INDEXER_API_ENDPOINT,
      MAX_RELAYER_DEPOSIT_LOOKBACK,
      RELAYER_ORIGIN_CHAINS,
      API_TIMEOUT_OVERRIDE,
      SWAP_API_KEY,
      INITIALIZATION_RETRY_ATTEMPTS,
      WITHDRAW_ENABLED,
      ENABLE_V3_WITHDRAWALS,
      ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER,
      ENABLE_DEPOSIT_ADDRESS_DEPOSIT_PUBLISHER,
      PUBSUB_GCP_PROJECT_ID,
      PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC,
    } = env;
    this.indexerPollingInterval = Number(INDEXER_API_POLLING_INTERVAL ?? 1); // Default to 1s
    this.periodicTaskInterval = Number(DEPOSIT_ADDRESS_PERIODIC_TASK_INTERVAL ?? 60); // Default to 60s
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
    this.enableDepositAddressDepositPublisher = ENABLE_DEPOSIT_ADDRESS_DEPOSIT_PUBLISHER === "true";
    this.pubSubGcpProjectId = PUBSUB_GCP_PROJECT_ID?.trim() ?? "";
    this.pubSubDepositAddressWithdrawTopic = PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC?.trim() ?? "";
    if (this.enableDepositAddressWithdrawPublisher || this.enableDepositAddressDepositPublisher) {
      if (!this.pubSubGcpProjectId) {
        throw new Error("PUBSUB_GCP_PROJECT_ID is required when a deposit-address publisher gate is enabled");
      }
      if (!this.pubSubDepositAddressWithdrawTopic) {
        throw new Error(
          "PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC is required when a deposit-address publisher gate is enabled"
        );
      }
    }
  }
}
