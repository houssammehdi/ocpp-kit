import { describe, expect, it } from 'vitest';
import { MAX_TIMER_DELAY_MS, timerDelay } from '../../src/util/timers.js';

describe('timerDelay', () => {
  it('passes ordinary delays through', () => {
    expect(timerDelay(0)).toBe(0);
    expect(timerDelay(1_500)).toBe(1_500);
    expect(timerDelay(MAX_TIMER_DELAY_MS)).toBe(MAX_TIMER_DELAY_MS);
  });

  it('caps delays Node.js would otherwise replace with 1 ms', () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647);
    expect(timerDelay(MAX_TIMER_DELAY_MS + 1)).toBe(MAX_TIMER_DELAY_MS);
    expect(timerDelay(3_000_000 * 1_000)).toBe(MAX_TIMER_DELAY_MS);
    expect(timerDelay(Infinity)).toBe(MAX_TIMER_DELAY_MS);
  });

  it('turns negative and NaN delays into 0', () => {
    expect(timerDelay(-5)).toBe(0);
    expect(timerDelay(Number.NaN)).toBe(0);
  });
});
