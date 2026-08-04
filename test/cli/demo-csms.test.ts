import { afterEach, describe, expect, it } from 'vitest';
import { executeCommand, renderStations } from '../../src/cli/csms.js';
import { DemoCsms } from '../../src/cli/demo-csms.js';
import {
  ChargePoint,
  ChargingStation,
  HandshakeError,
  SimulatedCharger,
  SimulatedChargingStation,
  type v201,
} from '../../src/index.js';
import { until } from '../helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const logs: string[] = [];
  const csms = new DemoCsms({
    heartbeatIntervalS: 30,
    log: (line) => logs.push(line),
    password: 'pw',
  });
  const { port } = await csms.listen(0, '127.0.0.1');
  cleanups.push(() => csms.close());
  const url = `ws://127.0.0.1:${port}`;
  const charger = new SimulatedCharger({
    identity: 'DEMO-1',
    url,
    password: 'pw',
    connectors: 2,
    meterValueSampleIntervalS: 1,
    tickMs: 100,
    client: { reconnect: false },
  });
  cleanups.push(() => charger.stop());
  await charger.start();
  await until(
    () => charger.isRegistered && (csms.stations.get('DEMO-1')?.connectors.size ?? 0) === 2,
  );
  return { csms, charger, logs, url };
}

describe('demo CSMS', () => {
  it('registers charge points and tracks connector state', async () => {
    const { csms } = await setup();
    const station = csms.stations.get('DEMO-1')!;
    expect(station).toMatchObject({ connected: true, vendor: 'ocpp-kit', model: 'Simulator' });
    expect([...station.connectors.values()].map((c) => c.status)).toEqual([
      'Available',
      'Available',
    ]);
    const screen = renderStations(csms, 10);
    expect(screen).toContain('1/1 online');
    expect(screen).toMatch(/DEMO-1\s+online\s+Simulator\s+1:Available 2:Available/);
  });

  it('remote-starts, meters, limits and remote-stops a session via interactive commands', async () => {
    const { csms, charger, logs } = await setup();
    expect((await executeCommand(csms, 'start DEMO-1 2 CARD')).output).toBe(
      'RemoteStartTransaction DEMO-1#2: Accepted',
    );
    charger.plugIn(2, { batteryKWh: 50, initialSoc: 0.3, targetSoc: 1, maxPowerW: 22_000 });
    await until(() => csms.totals().transactions === 1);
    await until(() => csms.totals().powerKW > 21);
    expect(logs.some((line) => line.includes('DEMO-1#2 started tx 1 for CARD'))).toBe(true);

    expect((await executeCommand(csms, 'limit DEMO-1 7.5')).output).toContain('Accepted');
    await until(() => csms.totals().powerKW > 0 && csms.totals().powerKW <= 7.5);
    expect((await executeCommand(csms, 'limit DEMO-1 off')).output).toContain('Accepted');

    expect((await executeCommand(csms, 'stop DEMO-1')).output).toBe(
      'RemoteStopTransaction DEMO-1 tx 1: Accepted',
    );
    await until(() => csms.totals().transactions === 0);
    expect(logs.some((line) => /stopped tx 1 \(Remote, \d+\.\d+ kWh\)/.test(line))).toBe(true);
    expect((await executeCommand(csms, 'stop DEMO-1')).output).toBe(
      'No active transaction on DEMO-1',
    );
  });

  it('auto-starts sessions on idle connectors', async () => {
    const { csms, charger } = await setup();
    expect(await csms.autoStart()).toBe(1);
    await until(() => charger.connectors[0]?.status === 'Preparing');
  });

  it('answers help, list, reset and bad input', async () => {
    const { csms } = await setup();
    expect((await executeCommand(csms, 'help')).output).toContain('start <id>');
    expect((await executeCommand(csms, 'list')).output).toBe('DEMO-1');
    expect((await executeCommand(csms, '')).output).toBe('');
    expect((await executeCommand(csms, 'quit')).quit).toBe(true);
    expect((await executeCommand(csms, 'dance')).output).toContain('unknown command');
    await expect(executeCommand(csms, 'start')).rejects.toThrow(/usage/);
    await expect(executeCommand(csms, 'limit DEMO-1 lots')).rejects.toThrow(/Invalid power/);
    await expect(executeCommand(csms, 'start NOBODY')).rejects.toThrow(/not connected/);
    expect((await executeCommand(csms, 'reset DEMO-1 hard')).output).toBe(
      'Reset DEMO-1 (Hard): Accepted',
    );
  });

  it('answers DataTransfer for unknown vendors with UnknownVendorId', async () => {
    // Regression: the demo used to answer Accepted, which section 4.3 does not allow.
    const { url } = await setup();
    const cp = new ChargePoint({ identity: 'VENDOR-TEST', url, password: 'pw', reconnect: false });
    cleanups.push(() => cp.close());
    await cp.connect();
    await expect(cp.call('DataTransfer', { vendorId: 'com.example' })).resolves.toEqual({
      status: 'UnknownVendorId',
    });
  });

  it('answers a replayed StartTransaction with the same transaction id', async () => {
    const { url } = await setup();
    const cp = new ChargePoint({ identity: 'REPLAY', url, password: 'pw', reconnect: false });
    cleanups.push(() => cp.close());
    await cp.connect();
    await cp.call('BootNotification', { chargePointVendor: 'V', chargePointModel: 'M' });
    const start = {
      connectorId: 1,
      idTag: 'T',
      meterStart: 5,
      timestamp: new Date().toISOString(),
    };
    const first = await cp.call('StartTransaction', start);
    const again = await cp.call('StartTransaction', start);
    const other = await cp.call('StartTransaction', { ...start, meterStart: 6 });
    expect(again.transactionId).toBe(first.transactionId);
    expect(other.transactionId).not.toBe(first.transactionId);
  });

  it('keeps main-meter values of connector 0 out of the connector list', async () => {
    // Regression: MeterValues for connector 0 created a connector 0 entry, which auto-start then
    // picked, sending RemoteStartTransaction with the invalid connectorId 0 (rejected locally)
    // on every round instead of starting connector 1.
    const { csms, url } = await setup();
    const cp = new ChargePoint({ identity: 'MAIN-METER', url, password: 'pw', reconnect: false });
    cleanups.push(() => cp.close());
    const remoteStarts: unknown[] = [];
    cp.handle('RemoteStartTransaction', (request) => {
      remoteStarts.push(request);
      return { status: 'Rejected' };
    });
    await cp.connect();
    await cp.call('BootNotification', { chargePointVendor: 'V', chargePointModel: 'M' });
    const timestamp = new Date().toISOString();
    await cp.call('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Available',
    });
    await cp.call('MeterValues', {
      connectorId: 0,
      meterValue: [{ timestamp, sampledValue: [{ value: '1234', context: 'Sample.Clock' }] }],
    });
    expect([...csms.stations.get('MAIN-METER')!.connectors.keys()]).toEqual([1]);
    await csms.autoStart();
    expect(remoteStarts).toEqual([{ idTag: 'AUTO', connectorId: 1 }]);
  });

  it('reserves, triggers, configures, updates firmware and fetches diagnostics', async () => {
    const { csms, charger, logs } = await setup();
    expect((await executeCommand(csms, 'reserve DEMO-1 2 CARD 5')).output).toBe(
      'ReserveNow DEMO-1#2 for CARD (reservation 1): Accepted',
    );
    await until(() => csms.stations.get('DEMO-1')?.connectors.get(2)?.status === 'Reserved');
    expect((await executeCommand(csms, 'cancel DEMO-1 1')).output).toBe(
      'CancelReservation DEMO-1 1: Accepted',
    );
    expect((await executeCommand(csms, 'trigger DEMO-1 Heartbeat')).output).toBe(
      'TriggerMessage DEMO-1 Heartbeat: Accepted',
    );
    expect((await executeCommand(csms, 'config DEMO-1 NumberOfConnectors')).output).toBe(
      'DEMO-1 NumberOfConnectors = 2 (read-only)',
    );
    expect((await executeCommand(csms, 'config DEMO-1 HeartbeatInterval 120')).output).toBe(
      'ChangeConfiguration DEMO-1 HeartbeatInterval=120: Accepted',
    );
    expect(charger.configuration.get('HeartbeatInterval')).toBe('120');
    expect((await executeCommand(csms, 'config DEMO-1 Nope')).output).toBe(
      'DEMO-1 Nope: unknown key',
    );
    expect(
      (await executeCommand(csms, 'diagnostics DEMO-1 ftp://logs.example.com/')).output,
    ).toMatch(/^GetDiagnostics DEMO-1: DEMO-1-diagnostics-\d{8}T\d{6}Z\.log$/);
    await until(() => logs.some((line) => line.includes('diagnostics: Uploading')));
    expect(
      (await executeCommand(csms, 'firmware DEMO-1 https://fw.example.com/v2.bin')).output,
    ).toBe('UpdateFirmware DEMO-1: requested https://fw.example.com/v2.bin');
    await until(() => logs.some((line) => line.includes('firmware: Downloading')));
    await expect(executeCommand(csms, 'trigger DEMO-1 Coffee')).rejects.toThrow(/usage: trigger/);
    await expect(executeCommand(csms, 'reserve DEMO-1')).rejects.toThrow(/usage: reserve/);
    expect((await executeCommand(csms, 'help')).output).toContain('reserve <id> <connector>');
  });

  it('refuses charge points with the wrong password', async () => {
    const { csms, url } = await setup();
    const intruder = new SimulatedCharger({
      identity: 'EVIL',
      url,
      password: 'guess',
      client: { reconnect: false },
    });
    cleanups.push(() => intruder.stop());
    await expect(intruder.start()).rejects.toBeInstanceOf(HandshakeError);
    expect(csms.cs.connections.has('EVIL')).toBe(false);
  });
});

describe('demo CSMS with OCPP 2.0.1 stations', () => {
  async function mixed() {
    const logs: string[] = [];
    const csms = new DemoCsms({ heartbeatIntervalS: 30, log: (line) => logs.push(line) });
    const { port } = await csms.listen(0, '127.0.0.1');
    cleanups.push(() => csms.close());
    const url = `ws://127.0.0.1:${port}`;
    const old = new SimulatedCharger({
      identity: 'OLD-1',
      url,
      connectors: 1,
      client: { reconnect: false },
    });
    const modern = new SimulatedChargingStation({
      identity: 'NEW-1',
      url,
      evses: 2,
      txUpdatedIntervalS: 1,
      tickMs: 100,
      client: { reconnect: false },
    });
    cleanups.push(
      () => old.stop(),
      () => modern.stop(),
    );
    await Promise.all([old.start(), modern.start()]);
    await until(
      () =>
        modern.isRegistered &&
        old.isRegistered &&
        (csms.stations.get('NEW-1')?.connectors.size ?? 0) === 2,
    );
    return { csms, modern, old, logs, url };
  }

  it('shows the version of every charge point in the table', async () => {
    const { csms } = await mixed();
    expect(csms.stations.get('NEW-1')).toMatchObject({
      version: '2.0.1',
      vendor: 'ocpp-kit',
      model: 'Simulator201',
    });
    expect(csms.stations.get('OLD-1')?.version).toBe('1.6');
    const screen = renderStations(csms, 10);
    expect(screen).toMatch(/OCPP\s+CHARGE POINT/);
    expect(screen).toMatch(/2\.0\.1\s+NEW-1\s+online\s+Simulator201\s+1:Available 2:Available/);
    expect(screen).toMatch(/1\.6\s+OLD-1\s+online/);
  });

  it('remote-starts, meters, limits and stops a 2.0.1 session with the same commands', async () => {
    const { csms, modern, logs } = await mixed();
    expect((await executeCommand(csms, 'start NEW-1 2 APP')).output).toBe(
      'RequestStartTransaction NEW-1#2: Accepted',
    );
    modern.plugIn(2, { batteryKWh: 50, initialSoc: 0.3, targetSoc: 1, maxPowerW: 22_000 });
    await until(() => csms.totals().transactions === 1);
    await until(() => csms.totals().powerKW > 21);
    const transactionId = modern.evses[1]!.transactionId!;
    expect(logs.some((line) => line.includes(`NEW-1#2 started tx ${transactionId} for APP`))).toBe(
      true,
    );
    expect((await executeCommand(csms, 'limit NEW-1 7.5')).output).toBe(
      'SetChargingProfile NEW-1 7.5 kW: Accepted',
    );
    await until(() => csms.totals().powerKW > 0 && csms.totals().powerKW <= 7.5);
    expect((await executeCommand(csms, 'limit NEW-1 off')).output).toBe(
      'ClearChargingProfile NEW-1: Accepted',
    );
    await until(() => csms.totals().energyKWh > 0);
    expect((await executeCommand(csms, 'stop NEW-1 2')).output).toBe(
      `RequestStopTransaction NEW-1 tx ${transactionId}: Accepted`,
    );
    await until(() => csms.totals().transactions === 0);
    expect(
      logs.some((line) =>
        new RegExp(`ended tx ${transactionId} \\(Remote, \\d+\\.\\d+ kWh\\)`).test(line),
      ),
    ).toBe(true);
  });

  it('configures, triggers, reserves, resets and updates 2.0.1 stations', async () => {
    const { csms, modern } = await mixed();
    expect(
      (await executeCommand(csms, 'config NEW-1 OCPPCommCtrlr.HeartbeatInterval')).output,
    ).toBe('NEW-1 OCPPCommCtrlr.HeartbeatInterval = 30');
    expect(
      (await executeCommand(csms, 'config NEW-1 OCPPCommCtrlr.HeartbeatInterval 45')).output,
    ).toBe('SetVariables NEW-1 OCPPCommCtrlr.HeartbeatInterval=45: Accepted');
    expect((await executeCommand(csms, 'config NEW-1 Nope.Nothing')).output).toBe(
      'NEW-1 Nope.Nothing: UnknownComponent',
    );
    expect((await executeCommand(csms, 'config NEW-1 HeartbeatInterval')).output).toContain(
      'Component.Variable',
    );
    expect((await executeCommand(csms, 'trigger NEW-1 StatusNotification 1')).output).toBe(
      'TriggerMessage NEW-1 StatusNotification: Accepted',
    );
    // A 1.6-only message name is refused by the 2.0.1 schema before it is sent.
    await expect(
      executeCommand(csms, 'trigger NEW-1 DiagnosticsStatusNotification'),
    ).rejects.toThrow(/invalid/);
    expect((await executeCommand(csms, 'reserve NEW-1 1 FRIEND 5')).output).toMatch(
      /ReserveNow NEW-1#1 for FRIEND \(reservation \d+\): Accepted/,
    );
    await until(() => modern.evses[0]?.status === 'Reserved');
    const reservationId = modern.reservations[0]!.id;
    expect((await executeCommand(csms, `cancel NEW-1 ${reservationId}`)).output).toBe(
      `CancelReservation NEW-1 ${reservationId}: Accepted`,
    );
    expect(
      (await executeCommand(csms, 'diagnostics NEW-1 https://logs.example.com')).output,
    ).toMatch(/^GetLog NEW-1: Accepted NEW-1-diagnostics-/);
    expect(
      (await executeCommand(csms, 'firmware NEW-1 https://fw.example.com/v2.bin')).output,
    ).toBe('UpdateFirmware NEW-1: Accepted https://fw.example.com/v2.bin');
    expect((await executeCommand(csms, 'reset NEW-1')).output).toBe(
      'Reset NEW-1 (OnIdle): Accepted',
    );
  });

  it('ignores replayed TransactionEvents (same transaction and seqNo)', async () => {
    const { csms, logs, url } = await mixed();
    const station = new ChargingStation({ identity: 'REPLAYER', url, reconnect: false });
    cleanups.push(() => station.close());
    await station.connect();
    await station.call('BootNotification', {
      chargingStation: { vendorName: 'V', model: 'M' },
      reason: 'PowerUp',
    });
    const now = new Date().toISOString();
    const event = (
      seqNo: number,
      eventType: 'Started' | 'Updated' | 'Ended',
      registerWh: number,
    ): v201.TransactionEventRequest => ({
      eventType,
      timestamp: now,
      triggerReason: eventType === 'Started' ? 'Authorized' : 'MeterValuePeriodic',
      seqNo,
      transactionInfo: { transactionId: 'replay-tx', chargingState: 'Charging' },
      ...(seqNo === 0 ? { evse: { id: 1, connectorId: 1 } } : {}),
      meterValue: [{ timestamp: now, sampledValue: [{ value: registerWh }] }],
    });
    await station.call('TransactionEvent', event(0, 'Started', 100));
    await station.call('TransactionEvent', event(0, 'Started', 100));
    await station.call('TransactionEvent', event(1, 'Updated', 600));
    // A replay carrying other values does not change what the CSMS recorded.
    await station.call('TransactionEvent', event(1, 'Updated', 9_000));
    const view = csms.stations.get('REPLAYER')?.connectors.get(1);
    expect(view).toMatchObject({ transactionId: 'replay-tx', energyWh: 500 });
    expect(logs.filter((line) => line.includes('replayed event'))).toHaveLength(2);
    await station.call('TransactionEvent', event(2, 'Ended', 700));
    await station.call('TransactionEvent', event(2, 'Ended', 700));
    expect(csms.totals().transactions).toBe(0);
    expect(view?.transactionId).toBeUndefined();
    expect(logs.filter((line) => line.includes('ended tx replay-tx'))).toHaveLength(1);
  });
});
