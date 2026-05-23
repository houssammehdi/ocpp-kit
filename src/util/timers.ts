/**
 * Largest delay Node.js timers support (2^31 - 1 ms, about 24.8 days).
 *
 * `setTimeout` and `setInterval` do not reject longer delays: they print a
 * `TimeoutOverflowWarning` and fire after 1 ms instead. A Central System that hands out a
 * month-long heartbeat interval would otherwise turn a charger into a message flood.
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Normalise a delay before passing it to `setTimeout`/`setInterval`: negative values and `NaN`
 * become 0, and anything above {@link MAX_TIMER_DELAY_MS} is capped at that maximum instead of
 * wrapping around to 1 ms.
 */
export function timerDelay(ms: number): number {
  if (!(ms > 0)) return 0;
  return Math.min(ms, MAX_TIMER_DELAY_MS);
}
