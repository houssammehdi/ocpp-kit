import { describe, expect, it } from 'vitest';
import { backoffDelay, DEFAULT_BACKOFF } from '../../src/index.js';

describe('backoffDelay', () => {
  const noJitter = {
    initialDelayMs: 100,
    maxDelayMs: 5_000,
    multiplier: 2,
    jitter: 'none',
  } as const;

  it('grows exponentially and caps at maxDelayMs', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, noJitter))).toEqual([
      100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000,
    ]);
  });

  it('applies full jitter: uniformly within [0, cap)', () => {
    expect(backoffDelay(3, { ...noJitter, jitter: 'full' }, () => 0)).toBe(0);
    expect(backoffDelay(3, { ...noJitter, jitter: 'full' }, () => 0.5)).toBe(400);
    expect(backoffDelay(3, { ...noJitter, jitter: 'full' }, () => 0.999_999)).toBe(799);
    expect(backoffDelay(20, { ...noJitter, jitter: 'full' }, () => 0.5)).toBe(2_500);
  });

  it('spreads a fleet of reconnecting chargers', () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const jittered = { ...noJitter, jitter: 'full' } as const;
    const delays = Array.from({ length: 1_000 }, () => backoffDelay(4, jittered, random));
    const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...delays)).toBeLessThan(1_600);
    expect(mean).toBeGreaterThan(700);
    expect(mean).toBeLessThan(900);
  });

  it('uses sensible defaults and tolerates odd attempt numbers', () => {
    expect(DEFAULT_BACKOFF).toEqual({
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      multiplier: 2,
      jitter: 'full',
    });
    expect(backoffDelay(-3, { jitter: 'none' })).toBe(1_000);
    expect(backoffDelay(1.7, { jitter: 'none' })).toBe(2_000);
    expect(backoffDelay(100, { jitter: 'none' })).toBe(30_000);
  });
});
