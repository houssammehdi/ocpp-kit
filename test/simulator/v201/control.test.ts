import { describe, expect, it } from 'vitest';
import type { v201 } from '../../../src/index.js';
import {
  advance,
  charging,
  EV,
  events,
  started,
  statuses,
  trace,
  useSimulatedTime,
} from './harness.js';

useSimulatedTime();

const token = (idToken: string): v201.IdToken => ({ idToken, type: 'Central' });
const later = (seconds: number) => new Date(Date.now() + seconds * 1_000).toISOString();

describe('SimulatedChargingStation remote control', () => {
  it('starts remotely, reports the remoteStartId once, and stops remotely', async () => {
    const { csms, station } = await started();
    const peer = csms.current!;
    expect(
      await peer.call('RequestStartTransaction', {
        idToken: token('APP-1'),
        remoteStartId: 77,
        evseId: 2,
      }),
    ).toEqual({ status: 'Accepted' });
    await advance(0);
    station.plugIn(2, EV);
    await advance(2);
    const [start, ...rest] = events(csms);
    expect(start).toMatchObject({
      eventType: 'Started',
      triggerReason: 'CablePluggedIn',
      idToken: { idToken: 'APP-1', type: 'Central' },
      transactionInfo: { remoteStartId: 77 },
    });
    expect(rest.every((event) => event.transactionInfo.remoteStartId === undefined)).toBe(true);
    const transactionId = station.evses[1]!.transactionId!;
    expect(await peer.call('GetTransactionStatus', { transactionId })).toEqual({
      ongoingIndicator: true,
      messagesInQueue: false,
    });
    expect(await peer.call('RequestStopTransaction', { transactionId: 'nope' })).toMatchObject({
      status: 'Rejected',
    });
    expect(await peer.call('RequestStopTransaction', { transactionId })).toEqual({
      status: 'Accepted',
    });
    await advance(0);
    expect(events(csms).at(-1)).toMatchObject({
      eventType: 'Ended',
      triggerReason: 'RemoteStop',
      transactionInfo: { stoppedReason: 'Remote' },
    });
    expect(await peer.call('GetTransactionStatus', { transactionId })).toEqual({
      ongoingIndicator: false,
      messagesInQueue: false,
    });
  });

  it('returns the running transaction id when the transaction started at the cable', async () => {
    const { csms, station } = await started({ txStartPoint: ['EVConnected'] });
    station.plugIn(1, EV);
    await advance(0);
    const transactionId = station.evses[0]!.transactionId;
    expect(
      await csms.current!.call('RequestStartTransaction', {
        idToken: token('APP-2'),
        remoteStartId: 5,
        evseId: 1,
      }),
    ).toEqual({ status: 'Accepted', transactionId });
    await advance(2);
    expect(trace(csms)).toEqual([
      'Started/CablePluggedIn',
      'Updated/RemoteStart',
      'Updated/ChargingStateChanged',
    ]);
    expect(events(csms)[1]?.transactionInfo.remoteStartId).toBe(5);
  });

  it('asks the CSMS first with AuthorizeRemoteStart and installs a TxProfile from the request', async () => {
    const { csms, station } = await started();
    station.deviceModel.set({ component: 'AuthCtrlr', variable: 'AuthorizeRemoteStart' }, 'true');
    station.plugIn(1, EV);
    const profile: v201.ChargingProfile = {
      id: 9,
      stackLevel: 0,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Relative',
      chargingSchedule: [
        {
          id: 1,
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 4_000 }],
        },
      ],
    };
    await csms.current!.call('RequestStartTransaction', {
      idToken: token('BLOCKED'),
      remoteStartId: 1,
      evseId: 1,
    });
    await advance(2);
    expect(csms.requestsOf('Authorize')).toHaveLength(1);
    expect(events(csms)).toHaveLength(0);
    await csms.current!.call('RequestStartTransaction', {
      idToken: token('APP-3'),
      remoteStartId: 2,
      evseId: 1,
      chargingProfile: profile,
    });
    await advance(3);
    expect(station.evses[0]).toMatchObject({ chargingState: 'Charging', powerW: 4_000 });
    const installed = station.profiles.profiles(1);
    expect(installed[0]?.profile.transactionId).toBe(station.evses[0]?.transactionId);
    // A profile that is not a TxProfile, or already names a transaction, is refused.
    expect(
      await csms.current!.call('RequestStartTransaction', {
        idToken: token('X'),
        remoteStartId: 3,
        evseId: 2,
        chargingProfile: { ...profile, chargingProfilePurpose: 'TxDefaultProfile' },
      }),
    ).toMatchObject({ status: 'Rejected' });
  });

  it('refuses to unlock under an authorized transaction and unlocks otherwise', async () => {
    const { csms, station } = await started();
    await charging(station);
    const peer = csms.current!;
    expect(await peer.call('UnlockConnector', { evseId: 1, connectorId: 1 })).toEqual({
      status: 'OngoingAuthorizedTransaction',
    });
    expect(await peer.call('UnlockConnector', { evseId: 9, connectorId: 1 })).toEqual({
      status: 'UnknownConnector',
    });
    expect(await peer.call('UnlockConnector', { evseId: 2, connectorId: 1 })).toEqual({
      status: 'Unlocked',
    });
  });

  it('answers TriggerMessage for status, meter values, transaction events and heartbeats', async () => {
    const { csms, station } = await started();
    await charging(station);
    const peer = csms.current!;
    const before = statuses(csms, 2).length;
    expect(
      await peer.call('TriggerMessage', {
        requestedMessage: 'StatusNotification',
        evse: { id: 2, connectorId: 1 },
      }),
    ).toEqual({ status: 'Accepted' });
    expect(
      await peer.call('TriggerMessage', { requestedMessage: 'TransactionEvent', evse: { id: 1 } }),
    ).toEqual({ status: 'Accepted' });
    expect(
      await peer.call('TriggerMessage', { requestedMessage: 'TransactionEvent', evse: { id: 2 } }),
    ).toEqual({ status: 'Rejected' });
    expect(
      await peer.call('TriggerMessage', { requestedMessage: 'MeterValues', evse: { id: 0 } }),
    ).toEqual({ status: 'Accepted' });
    expect(await peer.call('TriggerMessage', { requestedMessage: 'Heartbeat' })).toEqual({
      status: 'Accepted',
    });
    expect(await peer.call('TriggerMessage', { requestedMessage: 'SignV2GCertificate' })).toEqual({
      status: 'NotImplemented',
    });
    expect(
      await peer.call('TriggerMessage', {
        requestedMessage: 'StatusNotification',
        evse: { id: 7 },
      }),
    ).toEqual({ status: 'Rejected' });
    await advance(0);
    expect(statuses(csms, 2)).toHaveLength(before + 1);
    expect(events(csms).at(-1)).toMatchObject({ eventType: 'Updated', triggerReason: 'Trigger' });
    expect(JSON.stringify(csms.requestsOf('MeterValues').at(-1))).toContain('"evseId":0');
    expect(JSON.stringify(csms.requestsOf('MeterValues').at(-1))).toContain('Trigger');
  });
});

describe('SimulatedChargingStation availability and reset', () => {
  it('makes an idle EVSE Unavailable at once and a busy one after its transaction (Scheduled)', async () => {
    const { csms, station } = await started();
    await charging(station, 1);
    const peer = csms.current!;
    expect(
      await peer.call('ChangeAvailability', { operationalStatus: 'Inoperative', evse: { id: 2 } }),
    ).toEqual({ status: 'Accepted' });
    expect(
      await peer.call('ChangeAvailability', { operationalStatus: 'Inoperative', evse: { id: 1 } }),
    ).toEqual({ status: 'Scheduled' });
    expect(
      await peer.call('ChangeAvailability', { operationalStatus: 'Inoperative', evse: { id: 3 } }),
    ).toEqual({ status: 'Rejected' });
    await advance(0);
    expect(statuses(csms, 2).at(-1)).toBe('Unavailable');
    expect(await station.swipe(2, 'TOKEN-9')).toBe(false);
    station.stopTransaction(1);
    station.unplug(1);
    await advance(0);
    expect(statuses(csms, 1).at(-1)).toBe('Unavailable');
    expect(await peer.call('ChangeAvailability', { operationalStatus: 'Operative' })).toEqual({
      status: 'Accepted',
    });
    await advance(0);
    expect(statuses(csms, 1).at(-1)).toBe('Unavailable'); // EVSE-level state is kept
    await peer.call('ChangeAvailability', { operationalStatus: 'Operative', evse: { id: 1 } });
    await advance(0);
    expect(statuses(csms, 1).at(-1)).toBe('Available');
  });

  it('reports a fault as Faulted with a NotifyEvent and ends the transaction', async () => {
    const { csms, station } = await started();
    await charging(station, 1);
    station.fault(1);
    await advance(0);
    expect(events(csms).at(-1)).toMatchObject({
      eventType: 'Ended',
      triggerReason: 'AbnormalCondition',
    });
    expect(statuses(csms, 1).at(-1)).toBe('Faulted');
    const [event] = csms.requestsOf('NotifyEvent') as unknown as v201.NotifyEventRequest[];
    expect(event?.eventData[0]).toMatchObject({
      actualValue: 'Faulted',
      component: { name: 'Connector', evse: { id: 1, connectorId: 1 } },
      variable: { name: 'AvailabilityState' },
      trigger: 'Delta',
    });
    station.clearFault(1);
    await advance(0);
    expect(statuses(csms, 1).at(-1)).toBe('Occupied'); // the EV is still plugged in
    expect(csms.requestsOf('NotifyEvent').at(-1)).toMatchObject({ eventData: [{ cleared: true }] });
  });

  it('resets OnIdle after the transaction (Scheduled) and Immediate at once, booting with RemoteReset', async () => {
    const { csms, station } = await started();
    await charging(station, 1);
    const peer = csms.current!;
    expect(await peer.call('Reset', { type: 'OnIdle' })).toEqual({ status: 'Scheduled' });
    expect(await peer.call('Reset', { type: 'Immediate', evseId: 1 })).toMatchObject({
      status: 'Rejected',
    });
    await advance(5);
    expect(station.isRegistered).toBe(true);
    station.stopTransaction(1);
    await advance(3);
    expect(csms.requestsOf('BootNotification').map((r) => r.reason)).toEqual([
      'PowerUp',
      'RemoteReset',
    ]);
    await charging(station, 2);
    expect(await csms.current!.call('Reset', { type: 'Immediate' })).toEqual({
      status: 'Accepted',
    });
    await advance(3);
    const ended = events(csms).at(-1);
    expect(ended).toMatchObject({
      eventType: 'Ended',
      triggerReason: 'ResetCommand',
      transactionInfo: { stoppedReason: 'ImmediateReset' },
    });
    expect(csms.requestsOf('BootNotification')).toHaveLength(3);
    expect(csms.requestsOf('SecurityEventNotification').map((r) => r.type)).toContain(
      'ResetOrReboot',
    );
  });
});

describe('SimulatedChargingStation reservations', () => {
  it('holds a reserved EVSE for its token, uses the reservation in the transaction, and expires unused ones', async () => {
    const { csms, station } = await started();
    const peer = csms.current!;
    expect(
      await peer.call('ReserveNow', {
        id: 1,
        expiryDateTime: later(600),
        idToken: token('RES-1'),
        evseId: 1,
      }),
    ).toEqual({ status: 'Accepted' });
    await advance(0);
    expect(statuses(csms, 1).at(-1)).toBe('Reserved');
    expect(
      await peer.call('ReserveNow', {
        id: 2,
        expiryDateTime: later(600),
        idToken: token('X'),
        evseId: 1,
      }),
    ).toEqual({ status: 'Occupied' });
    expect(
      await peer.call('ReserveNow', {
        id: 3,
        expiryDateTime: later(600),
        idToken: token('X'),
        evseId: 2,
        connectorType: 'cCCS1',
      }),
    ).toMatchObject({ status: 'Rejected' });
    station.plugIn(1, EV);
    expect(await station.swipe(1, token('SOMEONE'))).toBe(false);
    expect(await station.swipe(1, token('RES-1'))).toBe(true);
    await advance(0);
    expect(events(csms)[0]).toMatchObject({ eventType: 'Started', reservationId: 1 });
    expect(station.reservations).toHaveLength(0);

    expect(
      await peer.call('ReserveNow', {
        id: 4,
        expiryDateTime: later(60),
        idToken: token('RES-2'),
        evseId: 2,
      }),
    ).toEqual({ status: 'Accepted' });
    await advance(61);
    expect(csms.requestsOf('ReservationStatusUpdate')).toEqual([
      { reservationId: 4, reservationUpdateStatus: 'Expired' },
    ]);
    expect(statuses(csms, 2).at(-1)).toBe('Available');
  });

  it('cancels reservations, removes them when the EVSE goes out of service, and honours NonEvseSpecific', async () => {
    const { csms, station } = await started();
    const peer = csms.current!;
    await peer.call('ReserveNow', {
      id: 1,
      expiryDateTime: later(600),
      idToken: token('A'),
      evseId: 2,
    });
    expect(await peer.call('CancelReservation', { reservationId: 1 })).toEqual({
      status: 'Accepted',
    });
    expect(await peer.call('CancelReservation', { reservationId: 1 })).toEqual({
      status: 'Rejected',
    });
    await peer.call('ReserveNow', {
      id: 2,
      expiryDateTime: later(600),
      idToken: token('B'),
      evseId: 2,
    });
    await peer.call('ChangeAvailability', { operationalStatus: 'Inoperative', evse: { id: 2 } });
    await advance(0);
    expect(csms.requestsOf('ReservationStatusUpdate')).toEqual([
      { reservationId: 2, reservationUpdateStatus: 'Removed' },
    ]);
    // Any-EVSE reservation: EVSE 1 is the only free one, so it is held for C.
    expect(
      await peer.call('ReserveNow', { id: 3, expiryDateTime: later(600), idToken: token('C') }),
    ).toEqual({ status: 'Accepted' });
    station.plugIn(1, EV);
    expect(await station.swipe(1, token('D'))).toBe(false);
    expect(await station.swipe(1, token('C'))).toBe(true);
    station.deviceModel.set(
      { component: 'ReservationCtrlr', variable: 'NonEvseSpecific' },
      'false',
    );
    expect(
      await peer.call('ReserveNow', { id: 4, expiryDateTime: later(600), idToken: token('E') }),
    ).toEqual({ status: 'Rejected' });
  });
});
