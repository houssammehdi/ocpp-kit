import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChargingStation,
  evictMeterValueUpdates,
  FileQueueStore,
  MemoryQueueStore,
  NotConnectedError,
  type ChargingStationOptions,
  type v201,
} from '../../src/index.js';
import { FakeCsms, NOW } from '../helpers.js';

const stations: ChargingStation[] = [];
afterEach(async () => {
  for (const station of stations.splice(0)) await station.close();
  vi.useRealTimers();
});

function setup(options: Partial<ChargingStationOptions> = {}, csms = new FakeCsms()) {
  csms.handlers.set('BootNotification', () => ({
    status: 'Accepted',
    currentTime: NOW,
    interval: 60,
  }));
  csms.handlers.set('TransactionEvent', () => ({}));
  csms.handlers.set('Heartbeat', () => ({ currentTime: NOW }));
  const station = new ChargingStation({
    identity: 'CS-1',
    url: 'ws://csms.test',
    connector: csms.connector,
    reconnect: { initialDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
    ...options,
  });
  stations.push(station);
  return { csms, station };
}

const boot = (station: ChargingStation) =>
  station.call('BootNotification', {
    chargingStation: { vendorName: 'Acme', model: 'Test' },
    reason: 'PowerUp',
  });

function event(
  seqNo: number,
  eventType: v201.TransactionEventRequest['eventType'] = 'Updated',
  triggerReason: v201.TransactionEventRequest['triggerReason'] = 'MeterValuePeriodic',
  transactionId = 'tx-1',
): v201.TransactionEventRequest {
  return {
    eventType,
    timestamp: NOW,
    triggerReason,
    seqNo,
    transactionInfo: { transactionId },
  };
}

describe('ChargingStation', () => {
  it('offers ocpp2.0.1 and speaks the 2.0.1 catalogue', async () => {
    const { csms, station } = setup();
    await station.connect();
    expect(csms.requests[0]?.protocols).toEqual(['ocpp2.0.1']);
    expect(station.protocol.version).toBe('2.0.1');
    expect((await boot(station)).status).toBe('Accepted');
    expect(station.registrationStatus).toBe('Accepted');
    // A 1.6 payload is refused locally, before it reaches the wire.
    await expect(
      station.call('BootNotification', {
        chargePointVendor: 'x',
        chargePointModel: 'y',
      } as never),
    ).rejects.toMatchObject({ code: 'FormatViolation', remote: false });
    await expect(
      new ChargingStation({ identity: 'X', url: 'ws://x', connector: csms.connector }).call(
        'Heartbeat',
        {},
      ),
    ).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('answers CSMS calls with typed handlers that see the station', async () => {
    const { csms, station } = setup();
    station.handle('ClearCache', (_request, { chargingStation }) => {
      expect(chargingStation).toBe(station);
      return { status: 'Accepted' };
    });
    await station.connect();
    expect(await csms.current!.call('ClearCache', {})).toEqual({ status: 'Accepted' });
    await expect(csms.current!.call('GetLocalListVersion', {})).rejects.toMatchObject({
      code: 'NotSupported',
    });
  });

  it('queues TransactionEvents offline and replays them in seqNo order after the boot', async () => {
    const { csms, station } = setup();
    csms.available = false;
    const connecting = station.connect();
    const delivered = [0, 1, 2].map((seqNo) =>
      station.call('TransactionEvent', {
        ...event(seqNo, seqNo === 0 ? 'Started' : 'Updated', 'CablePluggedIn'),
        offline: true,
      }),
    );
    await vi.waitFor(() => {
      expect(station.queueSize).toBe(3);
    });
    expect(station.hasQueuedEvents('tx-1')).toBe(true);
    expect(station.hasQueuedEvents('tx-2')).toBe(false);
    expect(station.hasQueuedEvents()).toBe(true);
    csms.available = true;
    await connecting;
    // Held until the BootNotification is accepted.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(csms.requestsOf('TransactionEvent')).toHaveLength(0);
    await boot(station);
    await Promise.all(delivered);
    expect(csms.requestsOf('TransactionEvent').map((request) => request.seqNo)).toEqual([0, 1, 2]);
    expect(station.hasQueuedEvents()).toBe(false);
  });

  it('retries a refused TransactionEvent MessageAttempts times, then drops it', async () => {
    const { csms, station } = setup({
      transactionMessageAttempts: 2,
      transactionMessageRetryIntervalMs: 5,
    });
    let calls = 0;
    csms.handlers.set('TransactionEvent', () => {
      calls++;
      throw new Error('database down');
    });
    const dropped = vi.fn();
    station.on('dropped', dropped);
    await station.connect();
    await boot(station);
    await expect(station.call('TransactionEvent', event(0, 'Started'))).rejects.toMatchObject({
      code: 'InternalError',
    });
    expect(calls).toBe(2);
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it('evicts only periodic Updated events from a full queue', async () => {
    expect(
      evictMeterValueUpdates({
        seq: 1,
        action: 'TransactionEvent',
        payload: event(1),
        enqueuedAt: NOW,
      }),
    ).toBe(true);
    for (const kept of [
      event(0, 'Started', 'CablePluggedIn'),
      event(1, 'Updated', 'ChargingStateChanged'),
      event(2, 'Ended', 'EVCommunicationLost'),
    ]) {
      expect(
        evictMeterValueUpdates({
          seq: 1,
          action: 'TransactionEvent',
          payload: kept,
          enqueuedAt: NOW,
        }),
      ).toBe(false);
    }
    const { csms, station } = setup({
      offlineQueue: { maxSize: 2, store: new MemoryQueueStore() },
    });
    csms.available = false;
    void station.connect();
    const started = station.call('TransactionEvent', event(0, 'Started', 'CablePluggedIn'));
    const periodic = station.call('TransactionEvent', event(1));
    const ended = station.call('TransactionEvent', event(2, 'Ended', 'EVCommunicationLost'));
    await expect(periodic).rejects.toThrow(/Evicted/);
    await expect(
      station.call('TransactionEvent', event(3, 'Ended', 'StopAuthorized')),
    ).rejects.toThrow(/full/);
    csms.available = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await boot(station);
    await Promise.all([started, ended]);
    // The gap in seqNo tells the CSMS that an event is missing.
    expect(csms.requestsOf('TransactionEvent').map((request) => request.seqNo)).toEqual([0, 2]);
  });

  it('restores a persisted queue into a new instance', async () => {
    const dir = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(`${(process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')}/ocpp-kit-cs-`),
    );
    const path = `${dir}/queue.json`;
    const first = setup({ offlineQueue: { store: new FileQueueStore(path) } });
    first.csms.available = false;
    first.station.connect().catch(() => undefined);
    const pending = first.station.call('TransactionEvent', event(0, 'Started', 'Authorized'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await first.station.close();
    await expect(pending).rejects.toThrow();
    const second = setup({ offlineQueue: { store: new FileQueueStore(path) } });
    await second.station.connect();
    await boot(second.station);
    await vi.waitFor(() => {
      expect(second.csms.requestsOf('TransactionEvent')).toHaveLength(1);
    });
    expect(second.station.queueSize).toBe(0);
  });
});
