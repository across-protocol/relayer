import { ProcessEnv } from "../common";

/** Cloud Run's request timeout. The application must give up before this to decide its own fate. */
const CLOUD_RUN_REQUEST_TIMEOUT_MS = 540_000;

/** Cloud Run sends SIGKILL this long after SIGTERM. A drain reaching it cannot complete. */
const CLOUD_RUN_SIGTERM_GRACE_MS = 10_000;

const DEFAULT_APPLICATION_DEADLINE_MS = 480_000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 8_000;
const DEFAULT_PORT = 8080;
const MAX_PORT = 65_535;

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
   * Why the Redis lock needs no renewal. A Cloud Run 504 does **not** stop handler code, so the
   * guarantee comes from the application: bound every outbound call, and never broadcast past this.
   */
  readonly applicationDeadlineMs: number;

  readonly shutdownDrainTimeoutMs: number;

  constructor(env: ProcessEnv) {
    this.port = readInteger("PORT", env.PORT, DEFAULT_PORT, MAX_PORT);
    this.executionEnabled = readBoolean(env.EXECUTION_ENABLED);

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
  }
}
