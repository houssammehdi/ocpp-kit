import { describe, expect, it } from 'vitest';
import {
  RpcError,
  type DiagnosticsUpload,
  type MeterValue,
  type ReservationEventKind,
} from '../../src/index.js';
import type { FakeCentralSystem } from '../helpers.js';
import {
  advance,
  charging,
  EV,
  setup,
  START,
  started,
  statuses,
  useSimulatedTime,
} from './harness.js';

useSimulatedTime();

const inMinutes = (minutes: number) => new Date(START.getTime() + minutes * 60_000).toISOString();

function meterValuesOf(csms: FakeCentralSystem) {
  return csms.requestsOf('MeterValues') as {
    connectorId: number;
    transactionId?: number;
    meterValue: MeterValue[];
  }[];
}

describe('Local Auth List Management', () => {
  it('follows the list version semantics of SendLocalList and GetLocalListVersion', async () => {
    const { csms } = await started();
    const cs = csms.current!;
    await expect(cs.call('GetLocalListVersion', {})).resolves.toEqual({ listVersion: 0 });
    await expect(
      cs.call('SendLocalList', {
        listVersion: 3,
        updateType: 'Full',
        localAuthorizationList: [
          { idTag: 'A', idTagInfo: { status: 'Accepted' } },
          { idTag: 'B', idTagInfo: { status: 'Blocked' } },
        ],
      }),
    ).resolves.toEqual({ status: 'Accepted' });
    await expect(cs.call('GetLocalListVersion', {})).resolves.toEqual({ listVersion: 3 });
    await expect(
      cs.call('SendLocalList', {
        listVersion: 3,
        updateType: 'Differential',
        localAuthorizationList: [{ idTag: 'B' }],
      }),
    ).resolves.toEqual({ status: 'VersionMismatch' });
    await expect(
      cs.call('SendLocalList', {
        listVersion: 4,
        updateType: 'Differential',
        localAuthorizationList: [{ idTag: 'B' }],
      }),
    ).resolves.toEqual({ status: 'Accepted' });
    await expect(cs.call('GetLocalListVersion', {})).resolves.toEqual({ listVersion: 4 });
  });

  it('authorizes listed cards offline and never accepts a listed Blocked card', async () => {
    const { csms, charger } = await started();
    await csms.current!.call('SendLocalList', {
      listVersion: 1,
      updateType: 'Full',
      localAuthorizationList: [
        { idTag: 'GOOD', idTagInfo: { status: 'Accepted' } },
        { idTag: 'BAD', idTagInfo: { status: 'Blocked' } },
      ],
    });
    csms.available = false;
    await csms.drop();
    await advance(1);
    charger.plugIn(1, EV);
    charger.plugIn(2, EV);
    expect(await charger.swipe(1, 'BAD')).toBe(false);
    expect(await charger.swipe(2, 'STRANGER')).toBe(false);
    expect(await charger.swipe(1, 'good')).toBe(true);
    expect(charger.connectors[0]?.status).toBe('Charging');
    csms.available = true;
    await advance(1);
    expect(csms.requestsOf('StartTransaction')).toEqual([
      expect.objectContaining({ connectorId: 1, idTag: 'good' }),
    ]);
    expect(csms.requestsOf('Authorize')).toEqual([]);
  });

  it('starts listed cards without Authorize when LocalPreAuthorize is set', async () => {
    const { csms, charger } = await started();
    const cs = csms.current!;
    await cs.call('SendLocalList', {
      listVersion: 1,
      updateType: 'Full',
      localAuthorizationList: [{ idTag: 'FAST', idTagInfo: { status: 'Accepted' } }],
    });
    await cs.call('ChangeConfiguration', { key: 'LocalPreAuthorize', value: 'true' });
    await charging(charger, 1, EV, 'FAST');
    expect(csms.requestsOf('Authorize')).toEqual([]);
    expect(csms.requestsOf('StartTransaction')).toHaveLength(1);
  });

  it('reports a LocalListConflict when the Central System disagrees with the list', async () => {
    const { csms, charger } = await started();
    await csms.current!.call('SendLocalList', {
      listVersion: 1,
      updateType: 'Full',
      localAuthorizationList: [{ idTag: 'CARD', idTagInfo: { status: 'Accepted' } }],
    });
    csms.handlers.set('Authorize', () => ({ idTagInfo: { status: 'Blocked' } }));
    charger.plugIn(1, EV);
    expect(await charger.swipe(1, 'CARD')).toBe(false);
    await advance(0);
    expect(csms.requestsOf('StatusNotification').at(-1)).toMatchObject({
      connectorId: 0,
      errorCode: 'LocalListConflict',
    });
  });

  it('answers -1 and NotSupported when the profile is disabled', async () => {
    const { csms, charger } = await started({
      featureProfiles: ['Core', 'SmartCharging', 'RemoteTrigger'],
    });
    const cs = csms.current!;
    await expect(cs.call('GetLocalListVersion', {})).resolves.toEqual({ listVersion: -1 });
    await expect(cs.call('SendLocalList', { listVersion: 1, updateType: 'Full' })).resolves.toEqual(
      { status: 'NotSupported' },
    );
    expect(charger.configuration.get('SupportedFeatureProfiles')).toBe(
      'Core,SmartCharging,RemoteTrigger',
    );
    expect(charger.configuration.has('LocalAuthListEnabled')).toBe(false);
  });
});

describe('Authorization Cache', () => {
  it('caches Authorize answers, uses them offline and forgets them on ClearCache', async () => {
    const { csms, charger } = await started();
    await charging(charger, 1, EV, 'REGULAR');
    expect(charger.authorizationCache.get('regular')).toEqual({ status: 'Accepted' });
    csms.available = false;
    await csms.drop();
    await advance(1);
    charger.plugIn(2, EV);
    expect(await charger.swipe(2, 'REGULAR')).toBe(true);
    csms.available = true;
    await advance(1);
    await expect(csms.current!.call('ClearCache', {})).resolves.toEqual({ status: 'Accepted' });
    expect(charger.authorizationCache.size).toBe(0);
  });

  it('updates the cache from StartTransaction.conf', async () => {
    const { csms, charger } = await started();
    csms.handlers.set('StartTransaction', () => ({
      idTagInfo: { status: 'Blocked' },
      transactionId: 5,
    }));
    charger.plugIn(1, EV);
    expect(await charger.swipe(1, 'CARD')).toBe(true);
    await advance(0);
    expect(charger.authorizationCache.get('CARD')?.status).toBe('Blocked');
  });
});

describe('transactions whose idTag the Central System refuses', () => {
  it('stops with DeAuthorized when StartTransaction.conf is not Accepted', async () => {
    const { csms, charger } = await started();
    csms.handlers.set('StartTransaction', () => ({
      idTagInfo: { status: 'Invalid' },
      transactionId: 5,
    }));
    charger.plugIn(1, EV);
    expect(await charger.swipe(1, 'TAG-1')).toBe(true);
    await advance(1);
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({
      transactionId: 5,
      reason: 'DeAuthorized',
    });
    expect(charger.connectors[0]?.status).toBe('Finishing');
  });

  it('only stops energy delivery when StopTransactionOnInvalidId is false', async () => {
    const { csms, charger } = await started();
    const cs = csms.current!;
    await cs.call('ChangeConfiguration', { key: 'StopTransactionOnInvalidId', value: 'false' });
    await cs.call('ChangeConfiguration', { key: 'MaxEnergyOnInvalidId', value: '100' });
    csms.handlers.set('StartTransaction', () => ({
      idTagInfo: { status: 'Invalid' },
      transactionId: 5,
    }));
    await charging(charger);
    await advance(20);
    expect(charger.connectors[0]).toMatchObject({ status: 'Charging', powerW: 11_000 });
    await advance(20); // 11 kW for 36 s is 110 Wh: over MaxEnergyOnInvalidId
    expect(charger.connectors[0]).toMatchObject({ status: 'SuspendedEVSE', powerW: 0 });
    const energy = charger.connectors[0]!.energyWh;
    expect(energy).toBeGreaterThanOrEqual(100);
    expect(energy).toBeLessThan(120);
    await advance(60);
    expect(charger.connectors[0]?.energyWh).toBe(energy);
    expect(csms.requestsOf('StopTransaction')).toHaveLength(0);
    // The transaction keeps reporting meter values while suspended.
    expect(meterValuesOf(csms).at(-1)).toMatchObject({ transactionId: 5 });
  });
});

describe('offline transactions', () => {
  it('queues the whole session, meter values included, and delivers it after reconnecting', async () => {
    // Regression: periodic meter values of a transaction whose StartTransaction was not yet
    // confirmed used to be dropped.
    const { csms, charger } = await started();
    charger.configuration.change('AllowOfflineTxForUnknownId', 'true');
    csms.available = false;
    await csms.drop();
    await advance(1);
    charger.plugIn(2, EV);
    expect(await charger.swipe(2, 'OFFLINE')).toBe(true);
    await advance(150); // two periodic samples
    const stopping = charger.stopTransaction(2);
    expect(charger.connectors[1]?.status).toBe('Finishing');
    csms.available = true;
    await advance(1);
    await stopping;
    const wire = csms.received.filter((action) =>
      ['StartTransaction', 'MeterValues', 'StopTransaction'].includes(action),
    );
    expect(wire).toEqual(['StartTransaction', 'MeterValues', 'MeterValues', 'StopTransaction']);
    const [start] = csms.requestsOf('StartTransaction');
    expect(start).toMatchObject({ connectorId: 2, idTag: 'OFFLINE' });
    expect(meterValuesOf(csms).map((mv) => mv.transactionId)).toEqual([1, 1]);
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({ transactionId: 1 });
  });
});

describe('stopping by a card of the same group', () => {
  it('accepts a different card only when it shares the parentIdTag', async () => {
    const { csms, charger } = await started();
    const parents: Record<string, string> = {
      'TAG-1': 'FLEET',
      'TAG-2': 'FLEET',
      'TAG-3': 'OTHER',
    };
    csms.handlers.set('Authorize', ({ idTag }) => ({
      idTagInfo: { status: 'Accepted', parentIdTag: parents[idTag] ?? 'NONE' },
    }));
    await charging(charger);
    expect(await charger.swipe(1, 'TAG-3')).toBe(false);
    expect(csms.requestsOf('StopTransaction')).toHaveLength(0);
    expect(await charger.swipe(1, 'TAG-2')).toBe(true);
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({
      idTag: 'TAG-2',
      reason: 'Local',
    });
    // The starting card itself needs no Authorize.
    const authorizations = csms.requestsOf('Authorize').length;
    await charging(charger, 2);
    expect(await charger.swipe(2, 'TAG-1')).toBe(true);
    expect(csms.requestsOf('Authorize')).toHaveLength(authorizations + 1);
  });
});

describe('Reservation', () => {
  async function reserve(
    csms: FakeCentralSystem,
    request: Partial<{
      connectorId: number;
      idTag: string;
      parentIdTag: string;
      reservationId: number;
      expiryDate: string;
    }> = {},
  ) {
    return csms.current!.call('ReserveNow', {
      connectorId: 1,
      idTag: 'TAG-R',
      reservationId: 7,
      expiryDate: inMinutes(10),
      ...request,
    });
  }

  it('reserves a connector and starts the reserved idTag with the reservationId', async () => {
    const { csms, charger } = await started();
    const events: [ReservationEventKind, number][] = [];
    charger.on('reservation', (kind, reservation) =>
      events.push([kind, reservation.reservationId]),
    );
    await expect(reserve(csms)).resolves.toEqual({ status: 'Accepted' });
    await advance(0);
    expect(charger.connectors[0]).toMatchObject({ status: 'Reserved', reservationId: 7 });
    expect(statuses(csms, 1).at(-1)).toBe('Reserved');
    charger.plugIn(1, EV);
    expect(charger.connectors[0]?.status).toBe('Reserved');
    expect(await charger.swipe(1, 'OTHER')).toBe(false);
    expect(await charger.swipe(1, 'tag-r')).toBe(true);
    await advance(0);
    expect(csms.requestsOf('StartTransaction')[0]).toMatchObject({
      connectorId: 1,
      idTag: 'tag-r',
      reservationId: 7,
    });
    expect(charger.reservations).toEqual([]);
    expect(statuses(csms, 1).slice(-3)).toEqual(['Reserved', 'Preparing', 'Charging']);
    expect(events).toEqual([
      ['reserved', 7],
      ['used', 7],
    ]);
  });

  it('lets an idTag of the reserved parent group use the reservation', async () => {
    const { csms, charger } = await started();
    csms.handlers.set('Authorize', () => ({
      idTagInfo: { status: 'Accepted', parentIdTag: 'FLEET' },
    }));
    await reserve(csms, { parentIdTag: 'FLEET' });
    charger.plugIn(1, EV);
    expect(await charger.swipe(1, 'COLLEAGUE')).toBe(true);
    await advance(0);
    expect(csms.requestsOf('StartTransaction')[0]).toMatchObject({ reservationId: 7 });
  });

  it('frees the connector when the reservation expires or is cancelled', async () => {
    const { csms, charger } = await started();
    const events: ReservationEventKind[] = [];
    charger.on('reservation', (kind) => events.push(kind));
    await reserve(csms, { expiryDate: new Date(START.getTime() + 30_000).toISOString() });
    await advance(31);
    expect(charger.connectors[0]?.status).toBe('Available');
    await reserve(csms, { reservationId: 8 });
    await expect(csms.current!.call('CancelReservation', { reservationId: 8 })).resolves.toEqual({
      status: 'Accepted',
    });
    await expect(csms.current!.call('CancelReservation', { reservationId: 99 })).resolves.toEqual({
      status: 'Rejected',
    });
    await advance(0);
    expect(charger.connectors[0]?.status).toBe('Available');
    expect(events).toEqual(['reserved', 'expired', 'reserved', 'cancelled']);
    expect(statuses(csms, 1).slice(-4)).toEqual(['Reserved', 'Available', 'Reserved', 'Available']);
  });

  it('answers Occupied, Faulted, Unavailable or Rejected as the connector requires', async () => {
    const { csms, charger } = await started();
    await charging(charger);
    await expect(reserve(csms)).resolves.toEqual({ status: 'Occupied' });
    await charger.fault(2, 'GroundFailure');
    await expect(reserve(csms, { connectorId: 2 })).resolves.toEqual({
      status: 'Faulted',
    });
    charger.clearFault(2);
    await csms.current!.call('ChangeAvailability', { connectorId: 2, type: 'Inoperative' });
    await advance(0);
    await expect(reserve(csms, { connectorId: 2 })).resolves.toEqual({
      status: 'Unavailable',
    });
    await expect(reserve(csms, { connectorId: 3 })).resolves.toEqual({
      status: 'Rejected',
    });
    await csms.current!.call('ChangeAvailability', { connectorId: 2, type: 'Operative' });
    await advance(0);
    await expect(reserve(csms, { connectorId: 2, expiryDate: inMinutes(-1) })).resolves.toEqual({
      status: 'Rejected',
    });
    await expect(reserve(csms, { connectorId: 2, reservationId: 1 })).resolves.toEqual({
      status: 'Accepted',
    });
    await expect(reserve(csms, { connectorId: 2, reservationId: 2 })).resolves.toEqual({
      status: 'Occupied',
    });
  });

  it('replaces a reservation with the same reservationId', async () => {
    const { csms, charger } = await started();
    await reserve(csms, { reservationId: 5, connectorId: 1 });
    await expect(reserve(csms, { reservationId: 5, connectorId: 2 })).resolves.toEqual({
      status: 'Accepted',
    });
    await advance(0);
    expect(charger.connectors.map((c) => c.status)).toEqual(['Available', 'Reserved']);
    expect(charger.reservations).toHaveLength(1);
  });

  it('keeps a connector free for a connector-0 reservation', async () => {
    const { csms, charger } = await started();
    await expect(
      reserve(csms, { connectorId: 0, idTag: 'TAG-Z', reservationId: 9 }),
    ).resolves.toEqual({ status: 'Accepted' });
    await expect(
      reserve(csms, { connectorId: 0, idTag: 'TAG-Y', reservationId: 10 }),
    ).resolves.toEqual({ status: 'Occupied' });
    await advance(0);
    // A station-wide reservation does not show as Reserved on any connector.
    expect(charger.connectors.map((c) => c.status)).toEqual(['Available', 'Available']);
    await charging(charger, 1, EV, 'SOMEONE');
    charger.plugIn(2, EV);
    expect(await charger.swipe(2, 'SOMEONE-ELSE')).toBe(false);
    expect(await charger.swipe(2, 'TAG-Z')).toBe(true);
    await advance(0);
    expect(csms.requestsOf('StartTransaction').at(-1)).toMatchObject({
      connectorId: 2,
      reservationId: 9,
    });
  });

  it('rejects connector-0 reservations without ReserveConnectorZeroSupported', async () => {
    const { csms } = await started({
      configuration: [
        { key: 'ReserveConnectorZeroSupported', value: 'false', readonly: true, type: 'boolean' },
      ],
    });
    await expect(reserve(csms, { connectorId: 0 })).resolves.toEqual({
      status: 'Rejected',
    });
  });

  it('ends the reservation when the connector faults', async () => {
    const { csms, charger } = await started();
    const events: ReservationEventKind[] = [];
    charger.on('reservation', (kind) => events.push(kind));
    await reserve(csms);
    await charger.fault(1);
    charger.clearFault(1);
    await advance(0);
    expect(charger.connectors[0]).toMatchObject({ status: 'Available', reservationId: undefined });
    expect(events).toEqual(['reserved', 'terminated']);
  });

  it('uses the reservation for a matching RemoteStartTransaction and refuses others', async () => {
    const { csms, charger } = await started();
    await reserve(csms);
    const cs = csms.current!;
    await expect(
      cs.call('RemoteStartTransaction', { idTag: 'OTHER', connectorId: 1 }),
    ).resolves.toEqual({ status: 'Rejected' });
    await expect(cs.call('RemoteStartTransaction', { idTag: 'TAG-R' })).resolves.toEqual({
      status: 'Accepted',
    });
    await advance(0);
    charger.plugIn(1, EV);
    await advance(0);
    expect(csms.requestsOf('StartTransaction')).toEqual([
      expect.objectContaining({ connectorId: 1, idTag: 'TAG-R', reservationId: 7 }),
    ]);
  });

  it('lets the autopilot driver who reserved show up and charge', async () => {
    const { csms } = await started({
      autopilot: { idleS: [7_200, 7_200], reservationArrivalS: [30, 60] },
    });
    await reserve(csms, { connectorId: 2 });
    await advance(80);
    expect(csms.requestsOf('StartTransaction')).toEqual([
      expect.objectContaining({ connectorId: 2, idTag: 'TAG-R', reservationId: 7 }),
    ]);
  });
});

describe('metering', () => {
  it('sends clock-aligned meter values for every connector at the boundaries', async () => {
    const { csms, charger } = await started();
    await csms.current!.call('ChangeConfiguration', {
      key: 'ClockAlignedDataInterval',
      value: '900',
    });
    const transactionId = await charging(charger);
    await advance(15 * 60 + 1);
    const aligned = meterValuesOf(csms).filter(
      (mv) => mv.meterValue[0]?.sampledValue[0]?.context === 'Sample.Clock',
    );
    expect(aligned.map((mv) => [mv.connectorId, mv.transactionId])).toEqual([
      [1, transactionId],
      [2, undefined],
    ]);
    expect(aligned[0]?.meterValue[0]?.timestamp).toBe('2026-05-01T12:15:00.000Z');
    expect(aligned[1]?.meterValue[0]?.sampledValue[0]).toMatchObject({
      measurand: 'Energy.Active.Import.Register',
      value: '0',
    });
  });

  it('stamps interval energy with the interval start and adds aligned data to transactionData', async () => {
    const { csms, charger } = await started();
    const cs = csms.current!;
    await cs.call('ChangeConfiguration', { key: 'ClockAlignedDataInterval', value: '900' });
    await cs.call('ChangeConfiguration', {
      key: 'MeterValuesAlignedData',
      value: 'Energy.Active.Import.Interval,Energy.Active.Import.Register',
    });
    await cs.call('ChangeConfiguration', {
      key: 'StopTxnAlignedData',
      value: 'Energy.Active.Import.Register',
    });
    await charging(charger);
    await advance(35 * 60);
    await charger.stopTransaction(1);
    const first = meterValuesOf(csms).find(
      (mv) => mv.connectorId === 1 && mv.meterValue[0]?.sampledValue[0]?.context === 'Sample.Clock',
    );
    expect(first?.meterValue.map((mv) => mv.timestamp)).toEqual([
      '2026-05-01T12:00:00.000Z',
      '2026-05-01T12:15:00.000Z',
    ]);
    const intervalWh = Number(first?.meterValue[0]?.sampledValue[0]?.value);
    expect(intervalWh).toBeGreaterThan(2_700);
    expect(intervalWh).toBeLessThanOrEqual(2_750);
    const data = csms.requestsOf('StopTransaction')[0]?.transactionData as MeterValue[];
    const clock = data.filter((mv) => mv.sampledValue[0]?.context === 'Sample.Clock');
    expect(clock.map((mv) => mv.timestamp)).toEqual([
      '2026-05-01T12:15:00.000Z',
      '2026-05-01T12:30:00.000Z',
    ]);
    expect(data[0]?.sampledValue[0]?.context).toBe('Transaction.Begin');
    expect(data.at(-1)?.sampledValue[0]?.context).toBe('Transaction.End');
  });

  it('reports phase-qualified measurands and refuses unsupported or overlong lists', async () => {
    const { csms, charger } = await started();
    const cs = csms.current!;
    await expect(
      cs.call('ChangeConfiguration', {
        key: 'MeterValuesSampledData',
        value: 'current.import.L1,Voltage.L2-N',
      }),
    ).resolves.toEqual({ status: 'Accepted' });
    expect(charger.configuration.get('MeterValuesSampledData')).toBe(
      'Current.Import.L1,Voltage.L2-N',
    );
    await charging(charger);
    await advance(60);
    const [sample] = meterValuesOf(csms);
    expect(sample?.meterValue[0]?.sampledValue.map((v) => [v.measurand, v.phase, v.value])).toEqual(
      [
        ['Current.Import', 'L1', '15.94'],
        ['Voltage', 'L2-N', '230.0'],
      ],
    );
    await expect(
      cs.call('ChangeConfiguration', { key: 'MeterValuesSampledData', value: 'RPM' }),
    ).resolves.toEqual({ status: 'Rejected' });
    const eleven = Array.from({ length: 11 }, () => 'SoC').join(',');
    await expect(
      cs.call('ChangeConfiguration', { key: 'StopTxnSampledData', value: eleven }),
    ).resolves.toEqual({ status: 'Rejected' });
  });
});

describe('StopTransactionOnEVSideDisconnect = false', () => {
  it('keeps the transaction when the cable is pulled out of the EV', async () => {
    const { csms, charger } = await started();
    await csms.current!.call('ChangeConfiguration', {
      key: 'StopTransactionOnEVSideDisconnect',
      value: 'false',
    });
    await charging(charger);
    await advance(10);
    charger.unplug(1);
    await advance(10);
    expect(charger.connectors[0]).toMatchObject({ status: 'SuspendedEV', powerW: 0 });
    expect(csms.requestsOf('StopTransaction')).toHaveLength(0);
    charger.plugIn(1, EV);
    await advance(1);
    expect(charger.connectors[0]).toMatchObject({ status: 'Charging', powerW: 11_000 });
    charger.unplug(1);
    await charger.stopTransaction(1);
    expect(charger.connectors[0]?.status).toBe('Available');
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({ reason: 'Local' });
  });
});

describe('Firmware Management', () => {
  const firmwareStatuses = (csms: FakeCentralSystem) =>
    csms.requestsOf('FirmwareStatusNotification').map((r) => r.status);

  it('downloads, installs, reboots into the new version and reports Installed', async () => {
    const { csms, charger } = await started({
      firmwareVersion: '1.0.0',
      firmware: { downloadMs: 10_000, installMs: 5_000 },
    });
    await expect(
      csms.current!.call('UpdateFirmware', {
        location: 'https://fw.example.com/acme-2.0.0.bin',
        retrieveDate: START.toISOString(),
      }),
    ).resolves.toEqual({});
    await advance(10);
    expect(firmwareStatuses(csms)).toEqual(['Downloading', 'Downloaded', 'Installing']);
    expect(charger.connectors.map((c) => c.status)).toEqual(['Unavailable', 'Unavailable']);
    await advance(5 + 1 + 1);
    expect(charger.firmwareVersion).toBe('acme-2.0.0.bin');
    expect(csms.requestsOf('BootNotification').map((r) => r.firmwareVersion)).toEqual([
      '1.0.0',
      'acme-2.0.0.bin',
    ]);
    expect(firmwareStatuses(csms)).toEqual([
      'Downloading',
      'Downloaded',
      'Installing',
      'Installed',
    ]);
    expect(charger.connectors.map((c) => c.status)).toEqual(['Available', 'Available']);
  });

  it('waits for a running session to end before installing', async () => {
    const { csms, charger } = await started({ firmware: { downloadMs: 1_000, installMs: 1_000 } });
    await charging(charger);
    await csms.current!.call('UpdateFirmware', {
      location: 'ftp://fw.example.com/v2.bin',
      retrieveDate: START.toISOString(),
    });
    await advance(60);
    expect(firmwareStatuses(csms)).toEqual(['Downloading', 'Downloaded']);
    expect(charger.connectors.map((c) => c.status)).toEqual(['Charging', 'Unavailable']);
    // New sessions are refused meanwhile.
    await expect(
      csms.current!.call('RemoteStartTransaction', { idTag: 'X', connectorId: 2 }),
    ).resolves.toEqual({ status: 'Rejected' });
    await charger.stopTransaction(1);
    await advance(0);
    expect(firmwareStatuses(csms)).toEqual(['Downloading', 'Downloaded', 'Installing']);
  });

  it('retries a failing download and reports DownloadFailed', async () => {
    const { csms } = await started({ firmware: { downloadMs: 100, failDownloadAttempts: 10 } });
    await csms.current!.call('UpdateFirmware', {
      location: 'https://fw.example.com/broken.bin',
      retrieveDate: START.toISOString(),
      retries: 1,
      retryInterval: 5,
    });
    await advance(10);
    expect(firmwareStatuses(csms)).toEqual(['Downloading', 'Downloading', 'DownloadFailed']);
  });

  it('uploads diagnostics and reports progress on TriggerMessage', async () => {
    const { csms, charger } = await started({
      diagnostics: { uploadMs: 3_000 },
      firmware: { downloadMs: 60_000 },
    });
    const uploads: DiagnosticsUpload[] = [];
    charger.on('diagnosticsUploaded', (upload) => uploads.push(upload));
    const cs = csms.current!;
    await expect(
      cs.call('GetDiagnostics', { location: 'ftp://logs.example.com/in/' }),
    ).resolves.toEqual({ fileName: 'SIM-001-diagnostics-20260501T120000Z.log' });
    await advance(1);
    await cs.call('TriggerMessage', { requestedMessage: 'DiagnosticsStatusNotification' });
    await cs.call('UpdateFirmware', {
      location: 'https://fw.example.com/v3.bin',
      retrieveDate: START.toISOString(),
    });
    await advance(1);
    await cs.call('TriggerMessage', { requestedMessage: 'FirmwareStatusNotification' });
    await advance(3);
    await cs.call('TriggerMessage', { requestedMessage: 'DiagnosticsStatusNotification' });
    await advance(0);
    expect(csms.requestsOf('DiagnosticsStatusNotification').map((r) => r.status)).toEqual([
      'Uploading',
      'Uploading', // triggered
      'Uploaded',
      'Idle', // triggered, nothing in progress
    ]);
    expect(firmwareStatuses(csms)).toEqual(['Downloading', 'Downloading']);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.content).toMatch(/>> \[2,"[^"]+","BootNotification"/);
  });
});

describe('feature profile selection', () => {
  it('answers requests of unsupported profiles with a NotSupported CALLERROR', async () => {
    const { csms, charger } = await started({ featureProfiles: ['Core'] });
    const cs = csms.current!;
    for (const pending of [
      cs.call('ReserveNow', {
        connectorId: 1,
        expiryDate: inMinutes(5),
        idTag: 'A',
        reservationId: 1,
      }),
      cs.call('TriggerMessage', { requestedMessage: 'Heartbeat' }),
      cs.call('UpdateFirmware', { location: 'ftp://x/y', retrieveDate: START.toISOString() }),
      cs.call('ClearChargingProfile', {}),
    ]) {
      const error = await pending.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RpcError);
      expect(error).toMatchObject({ code: 'NotSupported', remote: true });
    }
    expect(charger.configuration.get('SupportedFeatureProfiles')).toBe('Core');
    expect(charger.configuration.has('ChargeProfileMaxStackLevel')).toBe(false);
  });

  it('cannot run without the Core profile', () => {
    expect(() => setup({ featureProfiles: ['SmartCharging'] })).toThrow(RangeError);
  });
});
