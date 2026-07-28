import { describe, expect, it } from 'vitest';
import { SimulatedChargingStation, type LogUpload, type v201 } from '../../../src/index.js';
import { FakeCsms } from '../../helpers.js';
import {
  advance,
  charging,
  EV,
  events,
  setup,
  started,
  statuses,
  useSimulatedTime,
} from './harness.js';

useSimulatedTime();

const firmware = (seconds = 0, extra: Partial<v201.Firmware> = {}): v201.Firmware => ({
  location: 'https://fw.example.com/acme-2.0.bin',
  retrieveDateTime: new Date(Date.now() + seconds * 1_000).toISOString(),
  ...extra,
});

function firmwareStatuses(csms: FakeCsms): string[] {
  return csms
    .requestsOf('FirmwareStatusNotification')
    .map((r) => `${String(r.status)}#${String(r.requestId)}`);
}

describe('2.0.1 firmware updates', () => {
  it('downloads, verifies, installs after the session, reboots and reports Installed', async () => {
    const { csms, station } = await started({ firmware: { downloadMs: 1_000, installMs: 1_000 } });
    await charging(station);
    const peer = csms.current!;
    expect(
      await peer.call('UpdateFirmware', {
        requestId: 5,
        firmware: firmware(0, { signature: 'c2ln', signingCertificate: 'cert' }),
      }),
    ).toEqual({ status: 'Accepted' });
    await advance(5);
    // Waiting for the transaction to end before installing.
    expect(firmwareStatuses(csms)).toEqual([
      'Downloading#5',
      'Downloaded#5',
      'SignatureVerified#5',
    ]);
    expect(await station.swipe(2, 'TOKEN-2')).toBe(false);
    station.stopTransaction(1);
    await advance(6);
    expect(firmwareStatuses(csms)).toEqual([
      'Downloading#5',
      'Downloaded#5',
      'SignatureVerified#5',
      'Installing#5',
      'InstallRebooting#5',
      'Installed#5',
    ]);
    expect(station.firmwareVersion).toBe('acme-2.0.bin');
    expect(csms.requestsOf('BootNotification').map((r) => r.reason)).toEqual([
      'PowerUp',
      'FirmwareUpdate',
    ]);
    expect(csms.requestsOf('BootNotification')[1]).toMatchObject({
      chargingStation: { firmwareVersion: 'acme-2.0.bin' },
    });
    expect(csms.requestsOf('SecurityEventNotification').map((r) => r.type)).toContain(
      'FirmwareUpdated',
    );
  });

  it('schedules downloads and installations, retries, cancels, and reports failures', async () => {
    const { csms } = await started({
      firmware: { downloadMs: 1_000, installMs: 1_000, failDownloadAttempts: 1 },
    });
    const peer = csms.current!;
    expect(await peer.call('UpdateFirmware', { requestId: 1, firmware: firmware(3_600) })).toEqual({
      status: 'Accepted',
    });
    await advance(1);
    expect(firmwareStatuses(csms)).toEqual(['DownloadScheduled#1']);
    // A new request cancels the scheduled one.
    expect(
      await peer.call('UpdateFirmware', {
        requestId: 2,
        retries: 1,
        retryInterval: 5,
        firmware: firmware(0, { installDateTime: new Date(Date.now() + 60_000).toISOString() }),
      }),
    ).toEqual({ status: 'AcceptedCanceled' });
    await advance(10);
    expect(firmwareStatuses(csms)).toEqual([
      'DownloadScheduled#1',
      'Downloading#2',
      'Downloading#2',
      'Downloaded#2',
      'InstallScheduled#2',
    ]);
    await advance(60);
    expect(firmwareStatuses(csms).slice(-3)).toEqual([
      'Installing#2',
      'InstallRebooting#2',
      'Installed#2',
    ]);
  });

  it('reports DownloadFailed, InvalidSignature and InstallationFailed', async () => {
    const { csms: a } = await started({
      identity: 'A',
      firmware: { downloadMs: 100, failDownloadAttempts: 5 },
    });
    await a.current!.call('UpdateFirmware', {
      requestId: 1,
      retries: 1,
      retryInterval: 1,
      firmware: firmware(),
    });
    await advance(5);
    expect(firmwareStatuses(a)).toEqual(['Downloading#1', 'Downloading#1', 'DownloadFailed#1']);
    const { csms: b } = await started({
      identity: 'B',
      firmware: { downloadMs: 100, failSignature: true },
    });
    await b.current!.call('UpdateFirmware', {
      requestId: 2,
      firmware: firmware(0, { signature: 'x' }),
    });
    await advance(2);
    expect(firmwareStatuses(b)).toEqual(['Downloading#2', 'Downloaded#2', 'InvalidSignature#2']);
    expect(b.requestsOf('SecurityEventNotification').map((r) => r.type)).toContain(
      'InvalidFirmwareSignature',
    );
    const { csms: c } = await started({
      identity: 'C',
      firmware: { downloadMs: 100, installMs: 100, failInstallation: true },
    });
    await c.current!.call('UpdateFirmware', { requestId: 3, firmware: firmware() });
    await advance(2);
    expect(firmwareStatuses(c).at(-1)).toBe('InstallationFailed#3');
    expect(
      await c.current!.call('TriggerMessage', { requestedMessage: 'FirmwareStatusNotification' }),
    ).toEqual({ status: 'Accepted' });
    await advance(0);
    expect(c.requestsOf('FirmwareStatusNotification').at(-1)).toEqual({ status: 'Idle' });
  });
});

describe('2.0.1 log uploads', () => {
  it('uploads the protocol log, retries, and cancels a running upload for a new one', async () => {
    const { csms, station } = await started({ logs: { uploadMs: 1_000, failUploadAttempts: 1 } });
    const uploads: LogUpload[] = [];
    station.on('logUploaded', (upload) => uploads.push(upload));
    const peer = csms.current!;
    const response = await peer.call('GetLog', {
      requestId: 1,
      logType: 'DiagnosticsLog',
      retries: 1,
      retryInterval: 2,
      log: { remoteLocation: 'https://logs.example.com' },
    });
    expect(response.status).toBe('Accepted');
    expect(response.filename).toMatch(/^CS-001-diagnostics-\d{8}T\d{6}Z\.log$/);
    await advance(5);
    const statusesOf = () =>
      csms
        .requestsOf('LogStatusNotification')
        .map((r) => `${String(r.status)}#${String(r.requestId)}`);
    expect(statusesOf()).toEqual(['Uploading#1', 'Uploading#1', 'Uploaded#1']);
    expect(uploads[0]?.content).toContain('"BootNotification"');
    await peer.call('GetLog', {
      requestId: 2,
      logType: 'SecurityLog',
      log: { remoteLocation: 'https://logs.example.com' },
    });
    await advance(0);
    expect(
      await peer.call('GetLog', {
        requestId: 3,
        logType: 'SecurityLog',
        retries: 1,
        retryInterval: 1,
        log: { remoteLocation: 'https://logs.example.com' },
      }),
    ).toMatchObject({ status: 'AcceptedCanceled' });
    await advance(5);
    expect(statusesOf().slice(3)).toEqual([
      'Uploading#2',
      'AcceptedCanceled#2',
      // failUploadAttempts applies to every request: the first attempt fails, the retry works.
      'Uploading#3',
      'Uploading#3',
      'Uploaded#3',
    ]);
    // The security log only holds security events.
    expect(uploads.at(-1)?.content).toContain('security StartupOfTheDevice');
    expect(uploads.at(-1)?.content).not.toContain('BootNotification');
  });
});

describe('2.0.1 connection handling', () => {
  it('holds TransactionEvents while Pending and only boots again after a reboot', async () => {
    const csms = new FakeCsms();
    const { station } = setup({}, csms);
    let status: 'Pending' | 'Accepted' = 'Pending';
    csms.handlers.set('BootNotification', () => ({
      status,
      currentTime: new Date().toISOString(),
      interval: 5,
    }));
    await station.start();
    await advance(1);
    expect(station.registrationStatus).toBe('Pending');
    expect(csms.requestsOf('StatusNotification')).toHaveLength(0);
    // While Pending the CSMS may configure the station.
    expect(
      (
        await csms.current!.call('GetVariables', {
          getVariableData: [{ component: { name: 'TxCtrlr' }, variable: { name: 'TxStopPoint' } }],
        })
      ).getVariableResult[0]?.attributeValue,
    ).toBe('EVConnected,Authorized');
    status = 'Accepted';
    await advance(6);
    expect(station.isRegistered).toBe(true);
    expect(csms.requestsOf('BootNotification')).toHaveLength(2);
    await csms.drop();
    await advance(2);
    expect(station.isConnected).toBe(true);
    expect(csms.requestsOf('BootNotification')).toHaveLength(2);
  });

  it('reports only the connectors that changed during a short outage, all of them after a long one', async () => {
    const { csms, station } = await started();
    await csms.drop();
    csms.available = false;
    await advance(0);
    station.plugIn(1, EV);
    csms.available = true;
    await advance(2);
    expect(statuses(csms, 1)).toEqual(['Available', 'Occupied']);
    expect(statuses(csms, 2)).toEqual(['Available']);
    await csms.drop();
    csms.available = false;
    await advance(120);
    csms.available = true;
    await advance(5);
    expect(statuses(csms, 2)).toEqual(['Available', 'Available']);
  });

  it('answers DataTransfer with UnknownVendorId and GetTransactionStatus with the queue state', async () => {
    const { csms, station } = await started();
    const peer = csms.current!;
    expect(await peer.call('DataTransfer', { vendorId: 'com.example' })).toEqual({
      status: 'UnknownVendorId',
    });
    expect(await peer.call('GetTransactionStatus', {})).toEqual({ messagesInQueue: false });
    await charging(station);
    expect(events(csms)).toHaveLength(1);
  });
});

describe('2.0.1 autopilot', () => {
  async function run(seed: number): Promise<string[]> {
    const csms = new FakeCsms();
    const { station } = setup(
      { seed, autopilot: { idleS: [5, 20], maxSessionS: 600 }, txUpdatedIntervalS: 60 },
      csms,
    );
    await station.start();
    await advance(1_800);
    await station.stop();
    return csms.calls.map((call) => {
      const request = call.request as Partial<
        v201.TransactionEventRequest & v201.StatusNotificationRequest
      >;
      const kind = request.eventType ?? request.connectorStatus ?? '';
      return `${call.action}:${kind}:${request.triggerReason ?? ''}:${request.transactionInfo?.transactionId ?? ''}`;
    });
  }

  it('drives whole sessions on its own, and the same seed gives the same message log', async () => {
    const first = await run(3);
    const second = await run(3);
    expect(second).toEqual(first);
    expect(
      first.filter((line) => line.startsWith('TransactionEvent:Started')).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      first.filter((line) => line.startsWith('TransactionEvent:Ended')).length,
    ).toBeGreaterThanOrEqual(1);
    const other = await run(4);
    expect(other).not.toEqual(first);
  });

  it('keeps seqNo continuous per transaction across every session', async () => {
    const csms = new FakeCsms();
    const { station } = setup({ seed: 9, autopilot: { idleS: [5, 10], maxSessionS: 300 } }, csms);
    await station.start();
    await advance(3_600);
    const byTransaction = new Map<string, number[]>();
    for (const event of events(csms)) {
      const list = byTransaction.get(event.transactionInfo.transactionId) ?? [];
      list.push(event.seqNo);
      byTransaction.set(event.transactionInfo.transactionId, list);
    }
    expect(byTransaction.size).toBeGreaterThanOrEqual(3);
    for (const seqNos of byTransaction.values()) expect(seqNos).toEqual(seqNos.map((_, i) => i));
    expect(station).toBeInstanceOf(SimulatedChargingStation);
  });
});
