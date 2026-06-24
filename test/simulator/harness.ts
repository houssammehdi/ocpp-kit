import { afterEach, beforeEach, expect, vi } from 'vitest';
import { SimulatedCharger, type EvProfile, type SimulatedChargerOptions } from '../../src/index.js';
import { FakeCentralSystem } from '../helpers.js';

/** Simulated time at which every charger test starts. */
export const START = new Date('2026-05-01T12:00:00.000Z');
/** An EV that charges at a constant 11 kW for the whole test. */
export const EV: EvProfile = { batteryKWh: 60, initialSoc: 0.2, targetSoc: 1, maxPowerW: 11_000 };

const chargers: SimulatedCharger[] = [];

/** Fake timers from {@link START}; every charger created by {@link setup} is stopped after. */
export function useSimulatedTime(): void {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });
  afterEach(async () => {
    for (const charger of chargers.splice(0)) await charger.stop();
    vi.useRealTimers();
  });
}

/** Advance simulated time by `seconds`. */
export const advance = (seconds: number): Promise<unknown> =>
  vi.advanceTimersByTimeAsync(seconds * 1_000);

/**
 * A charger against an in-memory CSMS that accepts everything (id tag `BLOCKED` is refused) and
 * hands out transaction ids 1, 2, 3, ...
 */
export function setup(
  options: Partial<SimulatedChargerOptions> = {},
  csms = new FakeCentralSystem(),
): { csms: FakeCentralSystem; charger: SimulatedCharger } {
  let nextTransactionId = 1;
  csms.handlers.set('BootNotification', () => ({
    status: 'Accepted',
    currentTime: new Date().toISOString(),
    interval: 60,
  }));
  csms.handlers.set('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
  csms.handlers.set('StatusNotification', () => ({}));
  csms.handlers.set('Authorize', ({ idTag }) => ({
    idTagInfo: { status: idTag === 'BLOCKED' ? 'Blocked' : 'Accepted' },
  }));
  csms.handlers.set('StartTransaction', () => ({
    idTagInfo: { status: 'Accepted' },
    transactionId: nextTransactionId++,
  }));
  csms.handlers.set('StopTransaction', () => ({}));
  csms.handlers.set('MeterValues', () => ({}));
  csms.handlers.set('FirmwareStatusNotification', () => ({}));
  csms.handlers.set('DiagnosticsStatusNotification', () => ({}));
  const charger = new SimulatedCharger({
    identity: 'SIM-001',
    url: 'ws://csms.test',
    connectors: 2,
    meterValueSampleIntervalS: 60,
    rebootDelayMs: 1_000,
    ...options,
    client: {
      connector: csms.connector,
      reconnect: { initialDelayMs: 100, maxDelayMs: 500 },
      ...options.client,
    },
  });
  chargers.push(charger);
  return { csms, charger };
}

/** {@link setup}, then start and let the boot sequence finish. */
export async function started(
  options: Partial<SimulatedChargerOptions> = {},
  csms?: FakeCentralSystem,
): Promise<{ csms: FakeCentralSystem; charger: SimulatedCharger }> {
  const context = setup(options, csms);
  await context.charger.start();
  await advance(0);
  return context;
}

/** Statuses reported for one connector, in order. */
export function statuses(csms: FakeCentralSystem, connectorId: number): string[] {
  return csms
    .requestsOf('StatusNotification')
    .filter((r) => r.connectorId === connectorId)
    .map((r) => r.status as string);
}

/** Plug in and swipe `TAG-1`; resolves with the transaction id. */
export async function charging(
  charger: SimulatedCharger,
  connectorId = 1,
  ev = EV,
  idTag = 'TAG-1',
): Promise<number> {
  charger.plugIn(connectorId, ev);
  expect(await charger.swipe(connectorId, idTag)).toBe(true);
  await advance(0);
  const transactionId = charger.connectors[connectorId - 1]?.transactionId;
  expect(transactionId).toBeDefined();
  return transactionId!;
}
