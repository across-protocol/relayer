/**
 * Tracks in-flight requests so shutdown can drain rather than abandon them — the biggest lever on the
 * accepted residual risk of dying between broadcasting a transaction and persisting its hash. The
 * polling bot this replaces has no `SIGTERM` handler at all.
 *
 * Free of HTTP and process concerns, so it unit-tests directly.
 */
export class RequestLifecycle {
  private inFlight = 0;
  private draining = false;
  private drained?: () => void;

  /** False once shutdown has begun; both the readiness probe and the push route consult it. */
  get acceptingRequests(): boolean {
    return !this.draining;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  /** Returns the completion callback, which must be invoked exactly once — call it from a `finally`. */
  begin(): () => void {
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.inFlight -= 1;
      if (this.draining && this.inFlight === 0) {
        this.drained?.();
      }
    };
  }

  /** @returns true if the drain completed, false if it timed out with requests still running. */
  async beginDraining(timeoutMs: number): Promise<boolean> {
    this.draining = true;
    if (this.inFlight === 0) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.drained = undefined;
        resolve(false);
      }, timeoutMs);

      this.drained = () => {
        clearTimeout(timer);
        this.drained = undefined;
        resolve(true);
      };
    });
  }
}
