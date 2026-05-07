/** Reconnect backoff policy. */
export interface BackoffOptions {
  /** Delay cap for the first retry, in milliseconds. Default: 1 000. */
  readonly initialDelayMs?: number;
  /** Upper bound of any delay, in milliseconds. Default: 30 000. */
  readonly maxDelayMs?: number;
  /** Growth factor per attempt. Default: 2. */
  readonly multiplier?: number;
  /**
   * `full` (default) picks a uniformly random delay in `[0, cap)`, which spreads out a fleet of
   * chargers reconnecting after a CSMS outage. `none` uses the cap itself.
   */
  readonly jitter?: 'full' | 'none';
}

/** Resolved backoff policy with every field present. */
export type ResolvedBackoffOptions = Required<BackoffOptions>;

/** Default backoff policy. */
export const DEFAULT_BACKOFF: ResolvedBackoffOptions = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: 'full',
};

/**
 * Exponential backoff with optional "full jitter":
 * `delay = random(0, min(maxDelayMs, initialDelayMs * multiplier ^ attempt))`.
 *
 * @param attempt - zero-based retry number
 * @param random - source of uniform numbers in `[0, 1)`; injectable for deterministic tests
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const { initialDelayMs, maxDelayMs, multiplier, jitter } = { ...DEFAULT_BACKOFF, ...options };
  const exponent = Math.max(0, Math.floor(attempt));
  const cap = Math.min(maxDelayMs, initialDelayMs * multiplier ** exponent);
  if (jitter === 'none') return cap;
  return Math.floor(random() * cap);
}
