type CircuitState = 'closed' | 'open' | 'half_open';

const DEFAULT_ERROR_THRESHOLD = 3;
const DEFAULT_RESET_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Per-provider circuit breaker.
 *
 * State machine:
 *   CLOSED ──[threshold failures]──▶ OPEN ──[timeout]──▶ HALF_OPEN
 *     ▲                                                        │
 *     └────────────[test call succeeds]───────────────────────┘
 *
 * When OPEN, calls are blocked without touching the provider.
 * When HALF_OPEN, one test call is allowed through; success closes the circuit.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private errorThreshold: number;
  private resetTimeoutMs: number;

  constructor(
    errorThreshold: number = DEFAULT_ERROR_THRESHOLD,
    resetTimeoutMs: number = DEFAULT_RESET_TIMEOUT_MS
  ) {
    this.errorThreshold = errorThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
  }

  /**
   * Record a successful call.
   * Closes the circuit if we were testing recovery in half_open.
   */
  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.state = 'closed';
      this.failureCount = 0;
    } else if (this.state === 'closed') {
      this.failureCount = 0;
    }
  }

  /**
   * Record a failed call.
   * Opens the circuit once the error threshold is reached.
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.errorThreshold) {
      this.state = 'open';
    }
  }

  /**
   * Whether a call is permitted right now.
   * - closed: always true
   * - open: true only after the reset timeout has elapsed (transitions to half_open)
   * - half_open: true (allows one test call through)
   */
  canCall(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'half_open') return true;
    // open: check whether enough time has passed to try recovery
    if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.state = 'half_open';
      return true;
    }
    return false;
  }

  getState(): CircuitState {
    return this.state;
  }

  /** Force the circuit back to closed — useful for testing and admin resets. */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }
}
