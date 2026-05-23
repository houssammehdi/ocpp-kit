import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RpcError,
  SimulatedCharger,
  type ChargingProfile,
  type EvProfile,
  type SimulatedChargerOptions,
} from '../../src/index.js';
import { FakeCentralSystem } from '../helpers.js';

const START = new Date('2026-05-01T12:00:00.000Z');
const EV: EvProfile = { batteryKWh: 60, initialSoc: 0.2, targetSoc: 1, maxPowerW: 11_000 };

const chargers: SimulatedCharger[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(async () => {
  for (const charger of chargers.splice(0)) await charger.stop();
  vi.useRealTimers();
});

const advance = (seconds: number) => vi.advanceTimersByTimeAsync(seconds * 1_000);

function setup(options: Partial<SimulatedChargerOptions> = {}, csms = new FakeCentralSystem()) {
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

async function started(options: Partial<SimulatedChargerOptions> = {}) {
  const context = setup(options);
  await context.charger.start();
  await advance(0);
  return context;
}

function statuses(csms: FakeCentralSystem, connectorId: number): string[] {
  return csms
    .requestsOf('StatusNotification')
    .filter((r) => r.connectorId === connectorId)
    .map((r) => r.status as string);
}

async function charging(charger: SimulatedCharger, connectorId = 1, ev = EV) {
  charger.plugIn(connectorId, ev);
  expect(await charger.swipe(connectorId, 'TAG-1')).toBe(true);
  await advance(0);
  const transactionId = charger.connectors[connectorId - 1]?.transactionId;
  expect(transactionId).toBeDefined();
  return transactionId!;
}

describe('SimulatedCharger boot and heartbeat', () => {
  it('boots, applies the heartbeat interval and reports every connector', async () => {
    const { csms, charger } = await started();
    expect(charger.isRegistered).toBe(true);
    expect(csms.requestsOf('BootNotification')[0]).toMatchObject({
      chargePointVendor: 'ocpp-kit',
      chargePointModel: 'Simulator',
      chargePointSerialNumber: 'SIM-001',
    });
    expect(charger.configuration.get('HeartbeatInterval')).toBe('60');
    expect(csms.requestsOf('StatusNotification').map((r) => [r.connectorId, r.status])).toEqual([
      [0, 'Available'],
      [1, 'Available'],
      [2, 'Available'],
    ]);
    await advance(180);
    expect(csms.requestsOf('Heartbeat')).toHaveLength(3);
  });

  it('retries a Pending registration after the given interval', async () => {
    const { csms, charger } = setup();
    let accept = false;
    csms.handlers.set('BootNotification', () => ({
      status: accept ? 'Accepted' : 'Pending',
      currentTime: new Date().toISOString(),
      interval: 20,
    }));
    await charger.start();
    await advance(0);
    expect(charger.isRegistered).toBe(false);
    expect(csms.requestsOf('StatusNotification')).toHaveLength(0);
    accept = true;
    await advance(20);
    expect(csms.requestsOf('BootNotification')).toHaveLength(2);
    expect(charger.isRegistered).toBe(true);
  });

  it('does not flood the CSMS when an interval exceeds the Node.js timer range', async () => {
    // Regression: setInterval silently turns delays above 2^31-1 ms into 1 ms.
    const { csms, charger } = setup();
    csms.handlers.set('BootNotification', () => ({
      status: 'Accepted',
      currentTime: new Date().toISOString(),
      interval: 3_000_000,
    }));
    await charger.start();
    await advance(1);
    expect(charger.configuration.get('HeartbeatInterval')).toBe('3000000');
    expect(csms.requestsOf('Heartbeat')).toHaveLength(0);
    await csms.current!.call('ChangeConfiguration', {
      key: 'HeartbeatInterval',
      value: '2592000',
    });
    await advance(1);
    expect(csms.requestsOf('Heartbeat')).toHaveLength(0);
  });

  it('does not retry a Pending boot every millisecond when the interval is huge', async () => {
    const { csms, charger } = setup();
    csms.handlers.set('BootNotification', () => ({
      status: 'Pending',
      currentTime: new Date().toISOString(),
      interval: 4_000_000,
    }));
    await charger.start();
    await advance(1);
    expect(csms.requestsOf('BootNotification')).toHaveLength(1);
  });

  it('restarts the heartbeat when HeartbeatInterval changes', async () => {
    const { csms } = await started();
    await expect(
      csms.current!.call('ChangeConfiguration', { key: 'HeartbeatInterval', value: '10' }),
    ).resolves.toEqual({ status: 'Accepted' });
    await advance(35);
    expect(csms.requestsOf('Heartbeat')).toHaveLength(3);
  });
});

describe('SimulatedCharger sessions', () => {
  it('runs a local session: plug in, authorize, charge, meter, stop, unplug', async () => {
    const { csms, charger } = await started();
    const transactionId = await charging(charger);
    expect(csms.requestsOf('Authorize')).toEqual([{ idTag: 'TAG-1' }]);
    expect(csms.requestsOf('StartTransaction')[0]).toMatchObject({
      connectorId: 1,
      idTag: 'TAG-1',
      meterStart: 0,
      timestamp: START.toISOString(),
    });

    await advance(120);
    const meterValues = csms.requestsOf('MeterValues');
    expect(meterValues).toHaveLength(2);
    const registers = meterValues.map((mv) => {
      const [sample] = mv.meterValue as { sampledValue: { measurand?: string; value: string }[] }[];
      return Number(
        sample?.sampledValue.find((v) => v.measurand === 'Energy.Active.Import.Register')?.value,
      );
    });
    expect(registers[0]).toBeCloseTo((11_000 * 60) / 3_600, 0);
    expect(registers[1]).toBeCloseTo((11_000 * 120) / 3_600, 0);
    expect(meterValues[0]).toMatchObject({ connectorId: 1, transactionId });
    expect(charger.connectors[0]).toMatchObject({ status: 'Charging', powerW: 11_000 });

    expect(await charger.swipe(1, 'TAG-1')).toBe(true);
    await advance(0);
    const [stop] = csms.requestsOf('StopTransaction');
    expect(stop).toMatchObject({ transactionId, reason: 'Local', idTag: 'TAG-1', meterStop: 367 });
    expect(stop?.transactionData).toHaveLength(2);
    charger.unplug(1);
    await advance(0);
    expect(statuses(csms, 1)).toEqual([
      'Available',
      'Preparing',
      'Charging',
      'Finishing',
      'Available',
    ]);
    expect(charger.stats()).toMatchObject({ sessionsStarted: 1, sessionsCompleted: 1 });
  });

  it('compares id tags case-insensitively (IdToken is a CiString20)', async () => {
    const { csms, charger } = await started();
    await charging(charger);
    expect(await charger.swipe(1, 'tag-1')).toBe(true);
    await advance(0);
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({ reason: 'Local' });
  });

  it('does not start when authorization is refused', async () => {
    const { csms, charger } = await started();
    charger.plugIn(1, EV);
    expect(await charger.swipe(1, 'BLOCKED')).toBe(false);
    await advance(10);
    expect(csms.requestsOf('StartTransaction')).toHaveLength(0);
    expect(charger.connectors[0]?.status).toBe('Preparing');
  });

  it('stops with EVDisconnected when the cable is pulled mid-session', async () => {
    const { csms, charger } = await started();
    await charging(charger);
    await advance(30);
    charger.unplug(1);
    await advance(0);
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({ reason: 'EVDisconnected' });
    expect(statuses(csms, 1).at(-1)).toBe('Available');
  });

  it('moves to SuspendedEV when the battery is full and tapers power above 80 %', async () => {
    const { csms, charger } = await started();
    await charging(charger, 1, { ...EV, batteryKWh: 10, initialSoc: 0.85, targetSoc: 0.9 });
    await advance(1);
    const tapered = charger.connectors[0]!.powerW;
    expect(tapered).toBeLessThan(11_000);
    expect(tapered).toBeGreaterThan(5_000);
    await advance(600);
    expect(charger.connectors[0]).toMatchObject({ status: 'SuspendedEV', powerW: 0 });
    expect(statuses(csms, 1)).toContain('SuspendedEV');
  });

  it('can fault and recover a connector', async () => {
    const { csms, charger } = await started();
    await charging(charger);
    await charger.fault(1, 'GroundFailure');
    await advance(0);
    const faulted = csms.requestsOf('StatusNotification').at(-1);
    expect(faulted).toMatchObject({
      connectorId: 1,
      status: 'Faulted',
      errorCode: 'GroundFailure',
    });
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({ reason: 'Other' });
    charger.clearFault(1);
    await advance(0);
    expect(charger.connectors[0]?.status).toBe('Preparing');
  });

  it('delivers transaction messages after an outage, in order', async () => {
    const { csms, charger } = await started();
    await charging(charger);
    csms.available = false;
    await csms.drop();
    await advance(150);
    expect(charger.isConnected).toBe(false);
    // The StopTransaction is queued while offline and only settles after the reconnect.
    const stopping = charger.stopTransaction(1);
    csms.available = true;
    await advance(5);
    expect(charger.isConnected).toBe(true);
    await stopping;
    const tail = csms.received.filter((a) => a === 'MeterValues' || a === 'StopTransaction');
    expect(tail.at(-1)).toBe('StopTransaction');
    expect(tail.filter((a) => a === 'MeterValues').length).toBeGreaterThanOrEqual(2);
  });
});

describe('SimulatedCharger remote control', () => {
  it('remote start before plug-in waits for the cable and applies the TxProfile', async () => {
    const { csms, charger } = await started();
    const profile: ChargingProfile = {
      chargingProfileId: 7,
      stackLevel: 0,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Relative',
      chargingSchedule: {
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 6 }],
      },
    };
    await expect(
      csms.current!.call('RemoteStartTransaction', { idTag: 'APP', chargingProfile: profile }),
    ).resolves.toEqual({ status: 'Accepted' });
    await advance(0);
    expect(charger.connectors[0]?.status).toBe('Preparing');
    charger.plugIn(1, EV);
    await advance(2);
    expect(csms.requestsOf('StartTransaction')[0]).toMatchObject({ idTag: 'APP', connectorId: 1 });
    expect(charger.connectors[0]?.powerW).toBe(6 * 230 * 3);
    expect(charger.profiles.profiles(1)[0]?.profile.transactionId).toBe(1);
  });

  it('starts exactly one transaction when the cable is plugged in right after a remote start', async () => {
    const { csms, charger } = await started();
    await csms.current!.call('RemoteStartTransaction', { idTag: 'APP', connectorId: 1 });
    charger.plugIn(1, EV);
    await advance(1);
    expect(csms.requestsOf('StartTransaction')).toEqual([
      expect.objectContaining({ idTag: 'APP', connectorId: 1 }),
    ]);
    expect(charger.connectors[0]?.status).toBe('Charging');
  });

  it('cancels a remote start after ConnectionTimeOut', async () => {
    const { csms, charger } = await started();
    await csms.current!.call('ChangeConfiguration', { key: 'ConnectionTimeOut', value: '15' });
    await csms.current!.call('RemoteStartTransaction', { idTag: 'APP', connectorId: 2 });
    await advance(0);
    expect(charger.connectors[1]?.status).toBe('Preparing');
    await advance(15);
    expect(charger.connectors[1]?.status).toBe('Available');
    expect(csms.requestsOf('StartTransaction')).toHaveLength(0);
  });

  it('authorizes remote starts first when AuthorizeRemoteTxRequests is true', async () => {
    const { csms, charger } = await started();
    await csms.current!.call('ChangeConfiguration', {
      key: 'AuthorizeRemoteTxRequests',
      value: 'true',
    });
    charger.plugIn(1, EV);
    await csms.current!.call('RemoteStartTransaction', { idTag: 'BLOCKED', connectorId: 1 });
    await advance(1);
    expect(csms.requestsOf('Authorize')).toEqual([{ idTag: 'BLOCKED' }]);
    expect(csms.requestsOf('StartTransaction')).toHaveLength(0);
  });

  it('rejects remote starts it cannot serve', async () => {
    const { csms, charger } = await started({ connectors: 1 });
    await charging(charger);
    const cs = csms.current!;
    await expect(cs.call('RemoteStartTransaction', { idTag: 'X' })).resolves.toEqual({
      status: 'Rejected',
    });
    await expect(
      cs.call('RemoteStartTransaction', {
        idTag: 'X',
        chargingProfile: {
          chargingProfileId: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Relative',
          chargingSchedule: {
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 1 }],
          },
        },
      }),
    ).resolves.toEqual({ status: 'Rejected' });
  });

  it('stops a transaction remotely and rejects unknown ids', async () => {
    const { csms, charger } = await started();
    const transactionId = await charging(charger);
    const cs = csms.current!;
    await expect(cs.call('RemoteStopTransaction', { transactionId: 999 })).resolves.toEqual({
      status: 'Rejected',
    });
    await expect(cs.call('RemoteStopTransaction', { transactionId })).resolves.toEqual({
      status: 'Accepted',
    });
    await advance(0);
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({
      transactionId,
      reason: 'Remote',
    });
    expect(charger.connectors[0]?.status).toBe('Finishing');
  });

  it('unlocks a connector, ending its transaction', async () => {
    const { csms, charger } = await started();
    await charging(charger);
    await expect(csms.current!.call('UnlockConnector', { connectorId: 1 })).resolves.toEqual({
      status: 'Unlocked',
    });
    await expect(csms.current!.call('UnlockConnector', { connectorId: 9 })).resolves.toEqual({
      status: 'NotSupported',
    });
    await advance(0);
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({ reason: 'UnlockCommand' });
  });

  it('resets: stops transactions, disconnects and boots again', async () => {
    const { csms, charger } = await started();
    await charging(charger);
    const reboot = vi.fn();
    charger.on('reboot', reboot);
    await expect(csms.current!.call('Reset', { type: 'Soft' })).resolves.toEqual({
      status: 'Accepted',
    });
    await advance(0);
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({ reason: 'SoftReset' });
    expect(reboot).toHaveBeenCalledWith('Soft');
    await advance(2);
    expect(csms.peers).toHaveLength(2);
    expect(csms.requestsOf('BootNotification')).toHaveLength(2);
    expect(charger.isRegistered).toBe(true);
  });

  it('handles ChangeAvailability, scheduling it for busy connectors', async () => {
    const { csms, charger } = await started();
    await charging(charger);
    const cs = csms.current!;
    await expect(
      cs.call('ChangeAvailability', { connectorId: 1, type: 'Inoperative' }),
    ).resolves.toEqual({
      status: 'Scheduled',
    });
    await expect(
      cs.call('ChangeAvailability', { connectorId: 2, type: 'Inoperative' }),
    ).resolves.toEqual({
      status: 'Accepted',
    });
    await expect(
      cs.call('ChangeAvailability', { connectorId: 5, type: 'Inoperative' }),
    ).resolves.toEqual({
      status: 'Rejected',
    });
    await advance(0);
    expect(charger.connectors[1]?.status).toBe('Unavailable');
    expect(charger.connectors[0]?.status).toBe('Charging');
    await charger.stopTransaction(1);
    await advance(0);
    expect(charger.connectors[0]?.status).toBe('Unavailable');
    await cs.call('ChangeAvailability', { connectorId: 0, type: 'Operative' });
    await advance(0);
    expect(charger.connectors.map((c) => c.status)).toEqual(['Preparing', 'Available']);
    await cs.call('ChangeAvailability', { connectorId: 0, type: 'Inoperative' });
    await advance(0);
    expect(csms.requestsOf('StatusNotification').at(-1)).toMatchObject({
      connectorId: 0,
      status: 'Unavailable',
    });
  });

  it('answers TriggerMessage requests', async () => {
    const { csms, charger } = await started();
    await charging(charger);
    const cs = csms.current!;
    const before = csms.calls.length;
    await expect(
      cs.call('TriggerMessage', { requestedMessage: 'MeterValues', connectorId: 1 }),
    ).resolves.toEqual({
      status: 'Accepted',
    });
    await expect(cs.call('TriggerMessage', { requestedMessage: 'Heartbeat' })).resolves.toEqual({
      status: 'Accepted',
    });
    await expect(
      cs.call('TriggerMessage', { requestedMessage: 'StatusNotification', connectorId: 2 }),
    ).resolves.toEqual({
      status: 'Accepted',
    });
    await expect(
      cs.call('TriggerMessage', { requestedMessage: 'FirmwareStatusNotification' }),
    ).resolves.toEqual({
      status: 'NotImplemented',
    });
    await expect(
      cs.call('TriggerMessage', { requestedMessage: 'Heartbeat', connectorId: 3 }),
    ).resolves.toEqual({
      status: 'Rejected',
    });
    await advance(0);
    const triggered = csms.calls.slice(before);
    expect(triggered.map((c) => c.action)).toEqual([
      'MeterValues',
      'Heartbeat',
      'StatusNotification',
    ]);
    expect(triggered[0]?.request).toMatchObject({
      meterValue: [
        { sampledValue: expect.arrayContaining([expect.objectContaining({ context: 'Trigger' })]) },
      ],
    });
  });

  it('serves configuration, cache and data transfer requests', async () => {
    const { csms } = await started();
    const cs = csms.current!;
    await expect(
      cs.call('GetConfiguration', { key: ['NumberOfConnectors', 'Bogus'] }),
    ).resolves.toEqual({
      configurationKey: [{ key: 'NumberOfConnectors', readonly: true, value: '2' }],
      unknownKey: ['Bogus'],
    });
    await expect(
      cs.call('ChangeConfiguration', { key: 'NumberOfConnectors', value: '8' }),
    ).resolves.toEqual({
      status: 'Rejected',
    });
    await expect(cs.call('ClearCache', {})).resolves.toEqual({ status: 'Accepted' });
    await expect(cs.call('DataTransfer', { vendorId: 'acme' })).resolves.toEqual({
      status: 'UnknownVendorId',
    });
  });

  it('reports inbound validation failures to the CSMS with OCPP error codes', async () => {
    const { csms } = await started();
    // @ts-expect-error -- invalid on purpose
    const bad = csms.current!.call('Reset', { type: 'Warm' }, {});
    await expect(bad).rejects.toBeInstanceOf(RpcError);
  });
});

describe('SimulatedCharger smart charging', () => {
  const txDefault = (limit: number, id = 1): ChargingProfile => ({
    chargingProfileId: id,
    stackLevel: 0,
    chargingProfilePurpose: 'TxDefaultProfile',
    chargingProfileKind: 'Relative',
    chargingSchedule: {
      chargingRateUnit: 'A',
      chargingSchedulePeriod: [{ startPeriod: 0, limit }],
    },
  });

  it('honours SetChargingProfile limits and suspends at 0', async () => {
    const { csms, charger } = await started();
    await charging(charger, 1, { ...EV, maxPowerW: 22_000 });
    await advance(1);
    expect(charger.connectors[0]?.powerW).toBe(22_000);
    const cs = csms.current!;
    await expect(
      cs.call('SetChargingProfile', { connectorId: 0, csChargingProfiles: txDefault(10) }),
    ).resolves.toEqual({
      status: 'Accepted',
    });
    await advance(1);
    expect(charger.connectors[0]?.powerW).toBe(10 * 230 * 3);
    await cs.call('SetChargingProfile', { connectorId: 1, csChargingProfiles: txDefault(0, 2) });
    await advance(1);
    expect(charger.connectors[0]).toMatchObject({ status: 'SuspendedEVSE', powerW: 0 });
    await expect(cs.call('ClearChargingProfile', {})).resolves.toEqual({ status: 'Accepted' });
    await advance(1);
    expect(charger.connectors[0]).toMatchObject({ status: 'Charging', powerW: 22_000 });
    expect(statuses(csms, 1)).toEqual([
      'Available',
      'Preparing',
      'Charging',
      'SuspendedEVSE',
      'Charging',
    ]);
  });

  it('shares a ChargePointMaxProfile between active connectors', async () => {
    const { csms, charger } = await started();
    await charging(charger, 1);
    await charging(charger, 2);
    await csms.current!.call('SetChargingProfile', {
      connectorId: 0,
      csChargingProfiles: {
        chargingProfileId: 9,
        stackLevel: 0,
        chargingProfilePurpose: 'ChargePointMaxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: {
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 12_000 }],
        },
      },
    });
    await advance(1);
    expect(charger.connectors.map((c) => c.powerW)).toEqual([6_000, 6_000]);
    expect(charger.stats().powerW).toBe(12_000);
  });

  it('gives capacity one connector cannot use to the others (max-min fairness)', async () => {
    const { csms, charger } = await started();
    await charging(charger, 1, { ...EV, maxPowerW: 22_000 });
    await charging(charger, 2, { ...EV, maxPowerW: 7_400 });
    const cs = csms.current!;
    await cs.call('SetChargingProfile', {
      connectorId: 0,
      csChargingProfiles: {
        chargingProfileId: 9,
        stackLevel: 0,
        chargingProfilePurpose: 'ChargePointMaxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: {
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 20_000 }],
        },
      },
    });
    await advance(1);
    expect(charger.connectors.map((c) => c.powerW)).toEqual([12_600, 7_400]);
    // Pausing connector 2 hands its share to connector 1.
    await cs.call('SetChargingProfile', { connectorId: 2, csChargingProfiles: txDefault(0, 3) });
    await advance(1);
    expect(charger.connectors.map((c) => c.powerW)).toEqual([20_000, 0]);
    expect(charger.connectors[1]?.status).toBe('SuspendedEVSE');
  });

  it('rejects profiles for unknown connectors and TxProfiles without a transaction', async () => {
    const { csms } = await started();
    const cs = csms.current!;
    await expect(
      cs.call('SetChargingProfile', { connectorId: 3, csChargingProfiles: txDefault(10) }),
    ).resolves.toEqual({
      status: 'Rejected',
    });
    await expect(
      cs.call('SetChargingProfile', {
        connectorId: 1,
        csChargingProfiles: { ...txDefault(10), chargingProfilePurpose: 'TxProfile' },
      }),
    ).resolves.toEqual({ status: 'Rejected' });
  });

  it('answers GetCompositeSchedule', async () => {
    const { csms } = await started();
    const cs = csms.current!;
    await cs.call('SetChargingProfile', { connectorId: 1, csChargingProfiles: txDefault(16) });
    await expect(
      cs.call('GetCompositeSchedule', { connectorId: 1, duration: 3_600, chargingRateUnit: 'A' }),
    ).resolves.toMatchObject({
      status: 'Accepted',
      chargingSchedule: {
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }],
      },
    });
    await expect(
      cs.call('GetCompositeSchedule', { connectorId: 0, duration: 60 }),
    ).resolves.toMatchObject({
      chargingSchedule: {
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 44_000 }],
      },
    });
    await expect(
      cs.call('GetCompositeSchedule', { connectorId: 4, duration: 60 }),
    ).resolves.toEqual({
      status: 'Rejected',
    });
  });
});

describe('SimulatedCharger autopilot', () => {
  const autopilot = {
    idleS: [30, 120],
    plugInDelayS: [1, 3],
    swipeDelayS: [1, 3],
    dwellAfterFullS: [0, 30],
    unplugDelayS: [2, 5],
    maxSessionS: 1_800,
  } as const;

  async function run(seed: number) {
    vi.setSystemTime(START);
    const { csms, charger } = setup({ seed, autopilot, meterValueSampleIntervalS: 300 });
    await charger.start();
    await advance(2 * 3_600);
    await charger.stop();
    return {
      calls: csms.calls.map(({ action, request }) => ({ action, request })),
      stats: charger.stats(),
    };
  }

  it('runs complete sessions on its own', async () => {
    const { calls, stats } = await run(1);
    expect(stats.sessionsCompleted).toBeGreaterThanOrEqual(2);
    const actions = calls.map((c) => c.action);
    expect(actions).toContain('Authorize');
    expect(actions).toContain('StopTransaction');
    expect(stats.energyWh).toBeGreaterThan(1_000);
  });

  it('is deterministic for a given seed', async () => {
    const first = await run(7);
    const second = await run(7);
    const other = await run(8);
    expect(second.calls).toEqual(first.calls);
    expect(other.calls).not.toEqual(first.calls);
  });
});
