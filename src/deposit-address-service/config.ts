import { ProcessEnv } from "../common";
import { DEFAULT_CONFIRMATION_TRIES as CLIENT_CONFIRMATION_TRIES } from "../clients/TransactionClient";
import { parseJson } from "../utils";
import { LOCK_TTL_MS } from "./transferState";

/**
 * The Cloud Run request timeout this service is **provisioned with**, not a platform default — Cloud Run
 * defaults to 300s. The application must give up before it to decide its own fate, so the bound below
 * assumes the deployment raised it; nothing here can verify that. See the README's required platform
 * configuration.
 */
const CLOUD_RUN_REQUEST_TIMEOUT_MS = 540_000;

/** Cloud Run sends SIGKILL this long after SIGTERM. A drain reaching it cannot complete. */
const CLOUD_RUN_SIGTERM_GRACE_MS = 10_000;

const DEFAULT_APPLICATION_DEADLINE_MS = 480_000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 8_000;
const DEFAULT_PORT = 8080;
const MAX_PORT = 65_535;

/**
 * How many confirmation attempts a broadcast gets. Not a wait count: each timeout that resubmits recurses with
 * one fewer try, so the worst case is `M(M+1)/2` waits of the chain's confirmation cadence (24s on mainnet).
 *
 * 4 ⇒ ≤10 waits ⇒ ~240s, which fits inside {@link DEFAULT_CONFIRM_BUDGET_MS}. `TransactionClient`'s own
 * default of 10 would be 55 waits — ~22 minutes — outliving both the application deadline and the lock, which
 * is why raising this past the client's default is refused.
 */
const DEFAULT_CONFIRMATION_TRIES = 4;

/**
 * Time to reserve for the confirmation that runs *after* the deadline check, plus gas re-estimation on each
 * resubmit. Its only job is to keep the lock TTL wide enough to cover a broadcast that starts just inside the
 * deadline; see the invariant in the constructor.
 */
const DEFAULT_CONFIRM_BUDGET_MS = 300_000;

function readBoolean(value: string | undefined): boolean {
  return value === "true";
}

/**
 * Absent ⇒ default. **Present but invalid ⇒ startup error**, rather than silently running with something
 * other than what was configured. That distinction is the point: a typo in a timeout is otherwise
 * invisible until the behaviour it was protecting quietly stops happening.
 */
function readInteger(name: string, value: string | undefined, fallback: number, max: number): number {
  const raw = value?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be a positive integer no greater than ${max}; got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Standalone rather than extending `CommonConfig`: none of the hub-chain, block-lookback or pricing
 * settings apply, several of them throw during construction, and inheriting would carry config that is
 * dead here into a new service.
 *
 * Both timeouts are bounded by the platform limits they sit inside, because a violating value fails
 * silently at runtime — a drain reaching the SIGKILL grace never finishes, and a deadline past the
 * request timeout never fires before Cloud Run has given up.
 */
export class DepositAddressServiceConfig {
  readonly port: number;

  /** Defaults **false**. The absence of a producer is not protection: a subscription can be attached. */
  readonly executionEnabled: boolean;

  /**
   * Gates the v3 refund-withdraw path independently of {@link executionEnabled}, defaulting **false**.
   * Reuses `ENABLE_V3_WITHDRAWALS`, the same variable the polling bot reads, so both can run during
   * migration without new config. Disabled withdraws NACK — the funds are still on the deposit address,
   * and an ACK would discard the only delivery that could ever refund them.
   */
  readonly v3WithdrawalsEnabled: boolean;

  /**
   * Why the Redis lock needs no renewal. A Cloud Run 504 does **not** stop handler code, so the
   * guarantee comes from the application: bound every outbound call, and never broadcast past this.
   */
  readonly applicationDeadlineMs: number;

  readonly shutdownDrainTimeoutMs: number;

  /**
   * Origin chains this service will execute on. Reuses `RELAYER_ORIGIN_CHAINS`, the same variable the polling
   * bot reads, so no new configuration is needed to run both during migration — and so a chain can be turned
   * off without redeploying the indexer.
   */
  readonly originChains: number[];

  /** Passed to `AugmentedTransaction.maxTries`. See {@link DEFAULT_CONFIRMATION_TRIES}. */
  readonly confirmationTries: number;

  readonly confirmBudgetMs: number;

  /**
   * Gates announcing `withdraw_executed` over Pub/Sub. Reuses `ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER`,
   * the variable the polling bot already reads, so both can run during migration without new config.
   *
   * Off means a settled withdrawal is recorded but never announced, and the record says so — the timestamp
   * stays unset, so turning the gate on later lets a redelivery announce it after the fact.
   * `ENABLE_DEPOSIT_ADDRESS_DEPOSIT_PUBLISHER` is dead config here: the service never publishes deposits.
   */
  readonly withdrawPublisherEnabled: boolean;

  /** GCP project hosting the lifecycle topic. Required when {@link withdrawPublisherEnabled}. */
  readonly pubSubGcpProjectId: string;

  /** Short topic name, e.g. `topic-deposit-address-execution`. Required when {@link withdrawPublisherEnabled}. */
  readonly pubSubWithdrawTopic: string;

  constructor(env: ProcessEnv) {
    this.port = readInteger("PORT", env.PORT, DEFAULT_PORT, MAX_PORT);
    this.executionEnabled = readBoolean(env.EXECUTION_ENABLED);
    this.v3WithdrawalsEnabled = readBoolean(env.ENABLE_V3_WITHDRAWALS);
    this.originChains = parseJson.numberArray(env.RELAYER_ORIGIN_CHAINS);

    this.applicationDeadlineMs = readInteger(
      "APPLICATION_DEADLINE_MS",
      env.APPLICATION_DEADLINE_MS,
      DEFAULT_APPLICATION_DEADLINE_MS,
      CLOUD_RUN_REQUEST_TIMEOUT_MS - 1
    );

    // Strictly below the grace period, not equal to it: a drain running until the SIGKILL instant races
    // the kill and gains nothing.
    this.shutdownDrainTimeoutMs = readInteger(
      "SHUTDOWN_DRAIN_TIMEOUT_MS",
      env.SHUTDOWN_DRAIN_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
      CLOUD_RUN_SIGTERM_GRACE_MS - 1
    );

    this.confirmationTries = readInteger(
      "CONFIRMATION_TRIES",
      env.CONFIRMATION_TRIES,
      DEFAULT_CONFIRMATION_TRIES,
      CLIENT_CONFIRMATION_TRIES
    );

    this.confirmBudgetMs = readInteger(
      "CONFIRM_BUDGET_MS",
      env.CONFIRM_BUDGET_MS,
      DEFAULT_CONFIRM_BUDGET_MS,
      LOCK_TTL_MS - 1
    );

    this.withdrawPublisherEnabled = readBoolean(env.ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER);
    this.pubSubGcpProjectId = env.PUBSUB_GCP_PROJECT_ID?.trim() ?? "";
    this.pubSubWithdrawTopic = env.PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC?.trim() ?? "";
    // A gate that is on with nothing to publish to is the "running with something other than what was
    // configured" case this file refuses everywhere else — and here it would be invisible until a refund
    // settled and went unannounced.
    if (this.withdrawPublisherEnabled) {
      for (const [name, value] of [
        ["PUBSUB_GCP_PROJECT_ID", this.pubSubGcpProjectId],
        ["PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC", this.pubSubWithdrawTopic],
      ] as const) {
        if (value.length === 0) {
          throw new Error(`${name} is required when ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER is set`);
        }
      }
    }

    // The load-bearing relation, asserted rather than left as a comment.
    //
    // `assertBeforeDeadline` bounds when a broadcast *begins*; the confirmation wait runs after it. So a
    // broadcast starting just inside the deadline finishes at `deadline + confirmBudget`, and if the lock has
    // lapsed by then two consumers can be working one transfer. The lock is never renewed — a Cloud Run 504
    // does not stop handler code — so the TTL is the only thing covering that overhang.
    if (LOCK_TTL_MS < this.applicationDeadlineMs + this.confirmBudgetMs) {
      throw new Error(
        `lock TTL (${LOCK_TTL_MS}ms) must cover APPLICATION_DEADLINE_MS (${this.applicationDeadlineMs}ms) plus ` +
          `CONFIRM_BUDGET_MS (${this.confirmBudgetMs}ms); a broadcast beginning just inside the deadline would ` +
          "otherwise outlive its lock"
      );
    }
  }
}
