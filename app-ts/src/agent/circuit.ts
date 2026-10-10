/**
 * CircuitBreaker: state machine mirroring Python lifecycle/circuit.py.
 * CLOSED → (consecutive failures ≥ threshold) → OPEN → (cooldown cooldownMs) → HALF_OPEN → success: CLOSED / failure: OPEN.
 */
export type BreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private failureCount = 0;
  private openedAt = 0;
  private _state: BreakerState = "closed";

  constructor(
    private readonly failureThreshold = 3,
    private readonly cooldownMs = 30_000,
  ) {}

  get state(): BreakerState {
    return this._state;
  }

  get failures(): number {
    return this.failureCount;
  }

  /** ms until an OPEN breaker may be probed again (0 when not open) */
  get recoveryInMs(): number {
    return this._state === "open" ? Math.max(0, this.cooldownMs - (Date.now() - this.openedAt)) : 0;
  }

  get isTripped(): boolean {
    if (this._state === "open") {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this._state = "half_open";
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this._state = "closed";
  }

  recordFailure(): void {
    this.failureCount += 1;
    if (this._state === "half_open" || this.failureCount >= this.failureThreshold) {
      this._state = "open";
      this.openedAt = Date.now();
    }
  }
}
