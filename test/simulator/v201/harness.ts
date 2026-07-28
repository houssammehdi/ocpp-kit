import { afterEach, beforeEach, expect, vi } from 'vitest';
import {
  SimulatedChargingStation,
  type SimulatedChargingStationOptions,
  type v201,
} from '../../../src/index.js';
import { FakeCsms } from '../../helpers.js';
import { EV, START } from '../harness.js';

export { EV, START };

const stations: SimulatedChargingStation[] = [];

/** Fake timers from {@link START}; every station created by {@link setup} is stopped after. */
export function useSimulatedTime(): void {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });
  afterEach(async () => {
    for (const station of stations.splice(0)) await station.stop();
    vi.useRealTimers();
  });
}

/** Advance simulated time by `seconds`. */
export const advance = (seconds: number): Promise<unknown> =>
  vi.advanceTimersByTimeAsync(seconds * 1_000);

/**
 * A station against an in-memory CSMS that accepts everything; idToken `BLOCKED` is refused by
 * Authorize and TransactionEvent.
 */
export function setup(
  options: Partial<SimulatedChargingStationOptions> = {},
  csms = new FakeCsms(),
): { csms: FakeCsms; station: SimulatedChargingStation } {
  const info = (token: v201.IdToken | undefined): v201.IdTokenInfo => ({
    status: token?.idToken === 'BLOCKED' ? 'Blocked' : 'Accepted',
  });
  csms.handlers.set('BootNotification', () => ({
    status: 'Accepted',
    currentTime: new Date().toISOString(),
    interval: 60,
  }));
  csms.handlers.set('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
  csms.handlers.set('StatusNotification', () => ({}));
  csms.handlers.set('Authorize', ({ idToken }) => ({ idTokenInfo: info(idToken) }));
  csms.handlers.set('TransactionEvent', ({ idToken }) =>
    idToken ? { idTokenInfo: info(idToken) } : {},
  );
  for (const action of [
    'MeterValues',
    'NotifyReport',
    'NotifyEvent',
    'FirmwareStatusNotification',
    'LogStatusNotification',
    'ReservationStatusUpdate',
    'ReportChargingProfiles',
    'SecurityEventNotification',
    'NotifyChargingLimit',
    'ClearedChargingLimit',
  ] as const) {
    csms.handlers.set(action, () => ({}));
  }
  const station = new SimulatedChargingStation({
    identity: 'CS-001',
    url: 'ws://csms.test',
    evses: 2,
    rebootDelayMs: 1_000,
    ...options,
    client: {
      connector: csms.connector,
      reconnect: { initialDelayMs: 100, maxDelayMs: 500 },
      ...options.client,
    },
  });
  stations.push(station);
  return { csms, station };
}

/** {@link setup}, then start and let the boot sequence finish. */
export async function started(
  options: Partial<SimulatedChargingStationOptions> = {},
  csms?: FakeCsms,
): Promise<{ csms: FakeCsms; station: SimulatedChargingStation }> {
  const context = setup(options, csms);
  await context.station.start();
  await advance(0);
  return context;
}

/** The TransactionEvent requests received, in order. */
export function events(csms: FakeCsms): v201.TransactionEventRequest[] {
  return csms.requestsOf('TransactionEvent') as unknown as v201.TransactionEventRequest[];
}

/** `eventType/triggerReason` of every TransactionEvent received. */
export function trace(csms: FakeCsms): string[] {
  return events(csms).map((event) => `${event.eventType}/${event.triggerReason}`);
}

/** Connector statuses reported for one EVSE, in order. */
export function statuses(csms: FakeCsms, evseId: number): string[] {
  return csms
    .requestsOf('StatusNotification')
    .filter((r) => r.evseId === evseId)
    .map((r) => r.connectorStatus as string);
}

/** Plug in and swipe `TOKEN-1`; resolves with the transaction id. */
export async function charging(
  station: SimulatedChargingStation,
  evseId = 1,
  ev = EV,
  idToken = 'TOKEN-1',
): Promise<string> {
  station.plugIn(evseId, ev);
  expect(await station.swipe(evseId, idToken)).toBe(true);
  await advance(0);
  const transactionId = station.evses[evseId - 1]?.transactionId;
  expect(transactionId).toBeDefined();
  return transactionId!;
}
