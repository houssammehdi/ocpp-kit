/**
 * OCPP 1.6 and 2.0.1 over real WebSockets: one CentralSystem serving a mixed fleet, a full 2.0.1
 * transaction, offline replay, the device model and smart charging.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CentralSystem,
  Fleet,
  SimulatedCharger,
  SimulatedChargingStation,
  chargerFactory,
  stationFactory,
  type FleetMember,
  type OcppSubprotocol,
  type v201,
} from '../../src/index.js';
import { until } from '../helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const EV = { batteryKWh: 60, initialSoc: 0.2, targetSoc: 1, maxPowerW: 11_000 };

/** A small CSMS written on the library: both versions, every transaction message recorded. */
async function csms(options: { authenticate?: () => boolean } = {}) {
  const cs = new CentralSystem<OcppSubprotocol>({
    protocols: ['ocpp2.0.1', 'ocpp1.6'],
    pingIntervalMs: 0,
    ...(options.authenticate ? { authenticate: options.authenticate } : {}),
  });
  const events: v201.TransactionEventRequest[] = [];
  const boots: string[] = [];
  let nextTransactionId = 1;
  const accepted = {
    status: 'Accepted' as const,
    currentTime: new Date().toISOString(),
    interval: 60,
  };
  cs.handle('BootNotification', (_request, { connection }) => {
    boots.push(`1.6 ${connection.identity}`);
    return { ...accepted, currentTime: new Date().toISOString() };
  });
  cs.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
  cs.handle('StatusNotification', () => ({}));
  cs.handle('Authorize', () => ({ idTagInfo: { status: 'Accepted' } }));
  cs.handle('StartTransaction', () => ({
    idTagInfo: { status: 'Accepted' },
    transactionId: nextTransactionId++,
  }));
  cs.handle('MeterValues', () => ({}));
  cs.handle('StopTransaction', () => ({}));
  const v = cs.v201;
  v.handle('BootNotification', (_request, { connection }) => {
    boots.push(`2.0.1 ${connection.identity}`);
    return { ...accepted, currentTime: new Date().toISOString() };
  });
  v.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
  v.handle('StatusNotification', () => ({}));
  v.handle('SecurityEventNotification', () => ({}));
  v.handle('NotifyReport', () => ({}));
  v.handle('MeterValues', () => ({}));
  v.handle('Authorize', () => ({ idTokenInfo: { status: 'Accepted' } }));
  v.handle('TransactionEvent', (request) => {
    events.push(request);
    return request.idToken ? { idTokenInfo: { status: 'Accepted' } } : {};
  });
  const { port } = await cs.listen(0, '127.0.0.1');
  cleanups.push(() => cs.close({ timeoutMs: 500 }));
  return { cs, events, boots, url: `ws://127.0.0.1:${port}` };
}

function station(
  url: string,
  identity: string,
  extra: Partial<ConstructorParameters<typeof SimulatedChargingStation>[0]> = {},
) {
  const s = new SimulatedChargingStation({
    identity,
    url,
    evses: 2,
    tickMs: 50,
    txUpdatedIntervalS: 1,
    client: { reconnect: { initialDelayMs: 50, maxDelayMs: 100 } },
    ...extra,
  });
  cleanups.push(() => s.stop());
  return s;
}

const trace = (events: readonly v201.TransactionEventRequest[], transactionId: string) =>
  events
    .filter((event) => event.transactionInfo.transactionId === transactionId)
    .map((event) => `${event.seqNo} ${event.eventType}/${event.triggerReason}`);

describe('one CentralSystem, OCPP 1.6 and 2.0.1', () => {
  it('serves a mixed fleet, each charger in its own version', async () => {
    const { cs, boots, url } = await csms();
    const v16 = chargerFactory({ connectors: 1, client: { reconnect: false } });
    const v201 = stationFactory({ evses: 1, client: { reconnect: false } });
    const fleet = new Fleet<FleetMember>({
      url,
      count: 6,
      ratePerSecond: 100,
      create: (init) => (init.index % 2 === 0 ? v16(init) : v201(init)),
    });
    cleanups.push(() => fleet.stop());
    await fleet.start();
    await until(() => fleet.stats().registered === 6);
    const versions = [...cs.connections.values()].map((c) => `${c.identity} ${c.version}`).sort();
    expect(versions).toEqual([
      'SIM-001 1.6',
      'SIM-002 2.0.1',
      'SIM-003 1.6',
      'SIM-004 2.0.1',
      'SIM-005 1.6',
      'SIM-006 2.0.1',
    ]);
    expect(boots.filter((line) => line.startsWith('2.0.1'))).toHaveLength(3);
    expect(fleet.chargers.filter((c) => c instanceof SimulatedCharger)).toHaveLength(3);
    const stats = fleet.stats();
    expect(stats.callErrors).toBe(0);
    expect(stats.connectorStatuses.Available).toBe(6);
  });

  it('runs a whole 2.0.1 transaction started and stopped remotely', async () => {
    const { cs, events, url } = await csms();
    const s = station(url, 'CS-LIFE');
    await s.start();
    await until(() => s.isRegistered);
    // Cable plugged in first, then the remote start closes the power path.
    s.plugIn(1, EV);
    const started = await cs.v201.call('CS-LIFE', 'RequestStartTransaction', {
      idToken: { idToken: 'APP-USER', type: 'Central' },
      remoteStartId: 11,
      evseId: 1,
    });
    expect(started.status).toBe('Accepted');
    await until(() => s.evses[0]?.chargingState === 'Charging');
    const transactionId = s.evses[0]!.transactionId!;
    await until(() =>
      trace(events, transactionId).some((line) => line.endsWith('MeterValuePeriodic')),
    );
    // messagesInQueue may be true: a periodic event can be on its way at this very moment.
    expect(await cs.v201.call('CS-LIFE', 'GetTransactionStatus', { transactionId })).toMatchObject({
      ongoingIndicator: true,
    });
    expect(
      (await cs.v201.call('CS-LIFE', 'RequestStopTransaction', { transactionId })).status,
    ).toBe('Accepted');
    await until(() => events.some((e) => e.eventType === 'Ended'));
    const lines = trace(events, transactionId);
    expect(lines[0]).toBe('0 Started/RemoteStart');
    expect(lines).toContain('1 Updated/ChargingStateChanged');
    expect(lines.at(-1)).toMatch(/^\d+ Ended\/RemoteStop$/);
    expect(lines.map((line) => Number(line.split(' ')[0]))).toEqual(lines.map((_, i) => i));
    const first = events.find((e) => e.transactionInfo.transactionId === transactionId)!;
    expect(first).toMatchObject({
      evse: { id: 1, connectorId: 1 },
      transactionInfo: { remoteStartId: 11 },
    });
    const end = events.at(-1)!;
    expect(end.transactionInfo.stoppedReason).toBe('Remote');
    const register = end.meterValue?.at(-1)?.sampledValue[0];
    expect(register).toMatchObject({
      measurand: 'Energy.Active.Import.Register',
      context: 'Transaction.End',
    });
  });

  it('queues TransactionEvents while offline and replays them in seqNo order after reconnecting', async () => {
    let online = true;
    const { cs, events, url } = await csms({ authenticate: () => online });
    const s = station(url, 'CS-OFFLINE');
    await s.start();
    await until(() => s.isRegistered);
    s.plugIn(1, EV);
    expect(await s.swipe(1, 'CARD-1')).toBe(true);
    await until(() => s.evses[0]?.chargingState === 'Charging');
    const transactionId = s.evses[0]!.transactionId!;
    await until(() => trace(events, transactionId).length >= 3);
    // The network goes: the connection drops and reconnects are refused.
    online = false;
    cs.connections.get('CS-OFFLINE')?.terminate();
    await until(() => !s.isConnected);
    const before = events.length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    s.stopTransaction(1);
    expect(s.queueSize).toBeGreaterThanOrEqual(2);
    expect(events).toHaveLength(before);
    online = true;
    await until(() => events.some((e) => e.eventType === 'Ended'), 10_000);
    const seqNos = events
      .filter((e) => e.transactionInfo.transactionId === transactionId)
      .map((e) => e.seqNo);
    expect(seqNos).toEqual(seqNos.map((_, i) => i));
    const replayed = events.slice(before);
    expect(replayed.length).toBeGreaterThanOrEqual(2);
    expect(replayed.every((e) => e.offline === true)).toBe(true);
    expect(replayed.at(-1)).toMatchObject({ eventType: 'Ended', triggerReason: 'StopAuthorized' });
    expect(s.queueSize).toBe(0);
  });

  it('round-trips SetVariables and GetVariables, and the new value takes effect', async () => {
    const { cs, events, url } = await csms();
    const s = station(url, 'CS-VARS', { txUpdatedIntervalS: 60 });
    await s.start();
    await until(() => s.isRegistered);
    const txUpdated = {
      component: { name: 'SampledDataCtrlr' },
      variable: { name: 'TxUpdatedInterval' },
    };
    const set = await cs.v201.call('CS-VARS', 'SetVariables', {
      setVariableData: [
        { ...txUpdated, attributeValue: '1' },
        {
          component: { name: 'TxCtrlr' },
          variable: { name: 'TxStartPoint' },
          attributeValue: 'EVConnected',
        },
        {
          component: { name: 'ChargingStation' },
          variable: { name: 'Model' },
          attributeValue: 'X',
        },
      ],
    });
    expect(set.setVariableResult.map((r) => r.attributeStatus)).toEqual([
      'Accepted',
      'Accepted',
      'Rejected',
    ]);
    const got = await cs.v201.call('CS-VARS', 'GetVariables', {
      getVariableData: [
        txUpdated,
        { component: { name: 'TxCtrlr' }, variable: { name: 'TxStartPoint' } },
      ],
    });
    expect(got.getVariableResult.map((r) => r.attributeValue)).toEqual(['1', 'EVConnected']);
    // TxStartPoint=EVConnected: the cable alone starts the transaction; updates come every second.
    s.plugIn(2, EV);
    await until(() => s.evses[1]?.transactionId !== undefined);
    const transactionId = s.evses[1]!.transactionId!;
    await until(
      () =>
        trace(events, transactionId).filter((line) => line.endsWith('MeterValuePeriodic')).length >=
        2,
      6_000,
    );
    expect(trace(events, transactionId)[0]).toBe('0 Started/CablePluggedIn');
  });

  it('honours a charging profile set over the network and reports the composite schedule', async () => {
    const { cs, url } = await csms();
    const s = station(url, 'CS-SMART');
    await s.start();
    await until(() => s.isRegistered);
    s.plugIn(1, { ...EV, maxPowerW: 22_000 });
    await s.swipe(1, 'CARD-2');
    await until(() => (s.evses[0]?.powerW ?? 0) === 22_000);
    const transactionId = s.evses[0]!.transactionId!;
    const response = await cs.v201.call('CS-SMART', 'SetChargingProfile', {
      evseId: 1,
      chargingProfile: {
        id: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Relative',
        transactionId,
        chargingSchedule: [
          { id: 1, chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }] },
        ],
      },
    });
    expect(response.status).toBe('Accepted');
    await until(() => s.evses[0]?.powerW === 16 * 230 * 3);
    const composite = await cs.v201.call('CS-SMART', 'GetCompositeSchedule', {
      evseId: 1,
      duration: 600,
      chargingRateUnit: 'A',
    });
    expect(composite.schedule?.chargingSchedulePeriod).toEqual([{ startPeriod: 0, limit: 16 }]);
    // A TxProfile for another transaction is refused.
    const wrong = await cs.v201.call('CS-SMART', 'SetChargingProfile', {
      evseId: 1,
      chargingProfile: {
        id: 2,
        stackLevel: 1,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Relative',
        transactionId: 'someone-else',
        chargingSchedule: [
          { id: 1, chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 6 }] },
        ],
      },
    });
    expect(wrong).toMatchObject({ status: 'Rejected', statusInfo: { reasonCode: 'TxNotFound' } });
  });
});
