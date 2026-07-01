import { afterEach, describe, expect, it } from 'vitest';
import { executeCommand, renderStations } from '../../src/cli/csms.js';
import { DemoCsms } from '../../src/cli/demo-csms.js';
import { ChargePoint, HandshakeError, SimulatedCharger } from '../../src/index.js';
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
