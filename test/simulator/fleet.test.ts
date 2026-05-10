import { afterEach, describe, expect, it, vi } from 'vitest';
import { Fleet, LatencyTracker, type SimulatedCharger } from '../../src/index.js';
import { FakeCentralSystem } from '../helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

function fakeCsms(): FakeCentralSystem {
  const csms = new FakeCentralSystem();
  csms.handlers.set('BootNotification', () => ({
    status: 'Accepted',
    currentTime: new Date().toISOString(),
    interval: 300,
  }));
  csms.handlers.set('StatusNotification', () => ({}));
  return csms;
}

describe('Fleet', () => {
  it('ramps chargers up at the requested rate with padded identities', async () => {
    vi.useFakeTimers();
    const csms = fakeCsms();
    const fleet = new Fleet({
      url: 'ws://csms.test',
      count: 12,
      ratePerSecond: 4,
      identityPrefix: 'LOAD-',
      charger: { connectors: 1, client: { connector: csms.connector } },
    });
    const started: SimulatedCharger[] = [];
    fleet.on('chargerStarted', (charger) => started.push(charger));
    const done = fleet.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(started.map((c) => c.identity)).toEqual(
      Array.from({ length: 12 }, (_, i) => `LOAD-${String(i + 1).padStart(3, '0')}`),
    );
    const stats = fleet.stats();
    expect(stats).toMatchObject({
      chargers: 12,
      started: 12,
      connected: 12,
      registered: 12,
      connectorStatuses: { Available: 12 },
    });
    expect(stats.callsSent).toBe(12 * 3);
    expect(stats.latency.count).toBe(36);
    await fleet.stop();
    expect(fleet.stats().connected).toBe(0);
  });

  it('validates its options', () => {
    expect(() => new Fleet({ url: 'ws://x', count: 0 })).toThrow(RangeError);
    expect(() => new Fleet({ url: 'ws://x', count: 1, ratePerSecond: 0 }).start()).toThrow(
      RangeError,
    );
  });

  it('stops ramping when stopped early', async () => {
    vi.useFakeTimers();
    const csms = fakeCsms();
    const fleet = new Fleet({
      url: 'ws://csms.test',
      count: 10,
      ratePerSecond: 1,
      charger: { connectors: 1, client: { connector: csms.connector } },
    });
    const done = fleet.start();
    await vi.advanceTimersByTimeAsync(2_500);
    await fleet.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(fleet.stats().started).toBe(3);
  });
});

describe('LatencyTracker', () => {
  it('reports nearest-rank percentiles', () => {
    const tracker = new LatencyTracker();
    expect(tracker.summary()).toEqual({ count: 0, p50: 0, p95: 0, p99: 0, max: 0 });
    for (let i = 1; i <= 100; i++) tracker.record(i);
    expect(tracker.summary()).toEqual({ count: 100, p50: 50, p95: 95, p99: 99, max: 100 });
  });

  it('keeps only the most recent samples', () => {
    const tracker = new LatencyTracker(3);
    for (const ms of [100, 1, 2, 3]) tracker.record(ms);
    expect(tracker.summary()).toMatchObject({ count: 3, max: 3 });
    expect(tracker.total).toBe(4);
  });
});
