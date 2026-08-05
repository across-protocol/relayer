import { ProcessEnv } from "../common";

/** Cloud Run's request timeout. The application must give up before this to decide its own fate. */
const CLOUD_RUN_REQUEST_TIMEOUT_MS = 540_000;

/** Cloud Run sends SIGKILL this long after SIGTERM. A drain that outlasts it cannot complete. */
const CLOUD_RUN_SIGTERM_GRACE_MS = 10_000;

const DEFAULT_APPLICATION_DEADLINE_MS = 480_000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 8_000;
const DEFAULT_PORT = 8080;

function readBoolean(value: string | undefined): boolean {
  return value === "true";
}

function readInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Standalone rather than extending `CommonConfig`: none of the hub-chain, block-lookback or pricing
 * settings apply, several of them throw during construction, and inheriting would carry config that is
 * dead here into a new service.
 *
 * Both timeouts are validated against the platform limits they sit inside, because a violating value
 * fails silently at runtime — a drain past the SIGKILL grace never finishes, and a deadline past the
 * request timeout never fires before Cloud Run has given up.
 */
export class DepositAddressServiceConfig {
  readonly port: number;

  /** Defaults **false**. The absence of a producer is not protection: a subscription can be attached. */
  readonly executionEnabled: boolean;

  /**
   * Why the Redis lock needs no renewal. A Cloud Run 504 does **not** stop handler code, so the
   * guarantee comes from the application: bound every outbound call, and never broadcast past this.
   */
  readonly applicationDeadlineMs: number;

  readonly shutdownDrainTimeoutMs: number;

  constructor(env: ProcessEnv) {
    this.port = readInteger(env.PORT, DEFAULT_PORT);
    this.executionEnabled = readBoolean(env.EXECUTION_ENABLED);

    this.applicationDeadlineMs = readInteger(env.APPLICATION_DEADLINE_MS, DEFAULT_APPLICATION_DEADLINE_MS);
    if (this.applicationDeadlineMs >= CLOUD_RUN_REQUEST_TIMEOUT_MS) {
      throw new Error(
        `APPLICATION_DEADLINE_MS (${this.applicationDeadlineMs}) must be below the Cloud Run request ` +
          `timeout (${CLOUD_RUN_REQUEST_TIMEOUT_MS}), or Cloud Run gives up first and it guarantees nothing`
      );
    }

    this.shutdownDrainTimeoutMs = readInteger(env.SHUTDOWN_DRAIN_TIMEOUT_MS, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS);
    if (this.shutdownDrainTimeoutMs > CLOUD_RUN_SIGTERM_GRACE_MS) {
      throw new Error(
        `SHUTDOWN_DRAIN_TIMEOUT_MS (${this.shutdownDrainTimeoutMs}) exceeds Cloud Run's SIGKILL grace ` +
          `period (${CLOUD_RUN_SIGTERM_GRACE_MS}); the drain would be killed before finishing`
      );
    }
  }
}
