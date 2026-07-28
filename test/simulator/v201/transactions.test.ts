import { describe, expect, it } from 'vitest';
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

describe('SimulatedChargingStation transactions', () => {
  it('boots, reports every connector and keeps a heartbeat', async () => {
    const { csms, station } = await started();
    expect(csms.requestsOf('BootNotification')[0]).toMatchObject({
      reason: 'PowerUp',
      chargingStation: { vendorName: 'ocpp-kit', model: 'Simulator201', serialNumber: 'CS-001' },
    });
    expect(station.isRegistered).toBe(true);
    expect(statuses(csms, 1)).toEqual(['Available']);
    expect(statuses(csms, 2)).toEqual(['Available']);
    expect(csms.requestsOf('SecurityEventNotification')[0]).toMatchObject({
      type: 'StartupOfTheDevice',
    });
    // The interval of the BootNotificationResponse becomes OCPPCommCtrlr.HeartbeatInterval.
    expect(
      station.deviceModel.read({ component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval' }),
    ).toBe('60');
    await advance(125);
    expect(csms.requestsOf('Heartbeat')).toHaveLength(2);
  });

  it('runs a whole session with the default start and stop points (PowerPathClosed / EVConnected,Authorized)', async () => {
    const { csms, station } = await started();
    station.plugIn(1, EV);
    await advance(0);
    // Plugged in but not authorized: no transaction yet with TxStartPoint=PowerPathClosed.
    expect(events(csms)).toHaveLength(0);
    expect(statuses(csms, 1)).toEqual(['Available', 'Occupied']);
    expect(await station.swipe(1, 'TOKEN-1')).toBe(true);
    await advance(0);
    await advance(2);
    const [start] = events(csms);
    expect(start).toMatchObject({
      eventType: 'Started',
      triggerReason: 'Authorized',
      seqNo: 0,
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'TOKEN-1', type: 'ISO14443' },
      transactionInfo: { chargingState: 'EVConnected' },
    });
    expect(start?.meterValue?.[0]?.sampledValue[0]).toMatchObject({
      context: 'Transaction.Begin',
      measurand: 'Energy.Active.Import.Register',
      value: 0,
      unitOfMeasure: { unit: 'Wh' },
    });
    expect(station.evses[0]).toMatchObject({ chargingState: 'Charging', powerW: 11_000 });
    await advance(60);
    expect(await station.swipe(1, 'token-1')).toBe(true); // same token, any case
    await advance(0);
    expect(trace(csms)).toEqual([
      'Started/Authorized',
      'Updated/ChargingStateChanged',
      'Updated/MeterValuePeriodic',
      'Ended/StopAuthorized',
    ]);
    const all = events(csms);
    expect(all.map((event) => event.seqNo)).toEqual([0, 1, 2, 3]);
    expect(new Set(all.map((event) => event.transactionInfo.transactionId)).size).toBe(1);
    // Only the first event names the EVSE.
    expect(all.filter((event) => event.evse !== undefined)).toHaveLength(1);
    const end = all.at(-1)!;
    expect(end.transactionInfo).toMatchObject({
      stoppedReason: 'Local',
      chargingState: 'EVConnected',
    });
    expect(end.transactionInfo.timeSpentCharging).toBeGreaterThanOrEqual(60);
    expect(end.meterValue?.[0]?.sampledValue[0]?.context).toBe('Transaction.End');
    const energy = end.meterValue?.[0]?.sampledValue[0]?.value ?? 0;
    expect(energy).toBeGreaterThan(180); // 11 kW for about a minute
    station.unplug(1);
    await advance(0);
    expect(statuses(csms, 1)).toEqual(['Available', 'Occupied', 'Available']);
  });

  it('starts at the cable with TxStartPoint=EVConnected and authorizes during the transaction', async () => {
    const { csms, station } = await started({ txStartPoint: ['EVConnected'] });
    station.plugIn(1, EV);
    await advance(0);
    expect(trace(csms)).toEqual(['Started/CablePluggedIn']);
    expect(events(csms)[0]?.idToken).toBeUndefined();
    expect(station.evses[0]?.powerW).toBe(0);
    await station.swipe(1, 'TOKEN-1');
    await advance(2);
    expect(trace(csms)).toEqual([
      'Started/CablePluggedIn',
      'Updated/Authorized',
      'Updated/ChargingStateChanged',
    ]);
    expect(events(csms)[1]?.idToken?.idToken).toBe('TOKEN-1');
    station.unplug(1);
    await advance(0);
    expect(events(csms).at(-1)).toMatchObject({
      eventType: 'Ended',
      triggerReason: 'EVCommunicationLost',
      transactionInfo: { stoppedReason: 'EVDisconnected', chargingState: 'Idle' },
    });
  });

  it('starts at authorization with TxStartPoint=Authorized and ends it after EVConnectionTimeOut', async () => {
    const { csms, station } = await started({ txStartPoint: ['Authorized'] });
    station.deviceModel.set({ component: 'TxCtrlr', variable: 'EVConnectionTimeOut' }, '30');
    await station.swipe(2, 'TOKEN-2');
    await advance(0);
    expect(events(csms)[0]).toMatchObject({
      eventType: 'Started',
      triggerReason: 'Authorized',
      evse: { id: 2 },
      transactionInfo: { chargingState: 'Idle' },
    });
    // The connector is Occupied as long as the transaction exists.
    expect(statuses(csms, 2)).toEqual(['Available', 'Occupied']);
    await advance(31);
    expect(events(csms).at(-1)).toMatchObject({
      eventType: 'Ended',
      triggerReason: 'EVConnectTimeout',
      transactionInfo: { stoppedReason: 'Timeout' },
    });
    expect(statuses(csms, 2)).toEqual(['Available', 'Occupied', 'Available']);
  });

  it('keeps the transaction until the cable is unplugged when only EVConnected is a stop point', async () => {
    const { csms, station } = await started({ txStopPoint: ['EVConnected'] });
    await charging(station);
    await advance(10);
    await station.swipe(1, 'TOKEN-1');
    await advance(2);
    expect(station.evses[0]).toMatchObject({ chargingState: 'EVConnected', powerW: 0 });
    expect(trace(csms).slice(-1)).toEqual(['Updated/StopAuthorized']);
    station.unplug(1);
    await advance(0);
    expect(events(csms).at(-1)).toMatchObject({
      eventType: 'Ended',
      triggerReason: 'EVCommunicationLost',
      // The reason is the one that stopped the energy, not the unplugging.
      transactionInfo: { stoppedReason: 'Local' },
    });
  });

  it('suspends instead of ending on an EV-side disconnect with StopTxOnEVSideDisconnect=false', async () => {
    const { csms, station } = await started({ txStopPoint: ['EVConnected'] });
    station.deviceModel.set(
      { component: 'TxCtrlr', variable: 'StopTxOnEVSideDisconnect' },
      'false',
    );
    await charging(station);
    station.unplug(1);
    await advance(0);
    expect(events(csms).at(-1)).toMatchObject({
      eventType: 'Updated',
      triggerReason: 'EVCommunicationLost',
      transactionInfo: { chargingState: 'Idle' },
    });
    station.plugIn(1, EV);
    await advance(2);
    expect(trace(csms).slice(-2)).toEqual([
      'Updated/CablePluggedIn',
      'Updated/ChargingStateChanged',
    ]);
    expect(station.evses[0]?.chargingState).toBe('Charging');
  });

  it('samples TxUpdatedMeasurands every TxUpdatedInterval and TxEndedMeasurands into the Ended event', async () => {
    const { csms, station } = await started({ txUpdatedIntervalS: 30 });
    station.deviceModel.set({ component: 'SampledDataCtrlr', variable: 'TxEndedInterval' }, '20');
    station.deviceModel.set(
      { component: 'SampledDataCtrlr', variable: 'TxUpdatedMeasurands' },
      'Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage,SoC',
    );
    await charging(station);
    await advance(61);
    const periodic = events(csms).filter((event) => event.triggerReason === 'MeterValuePeriodic');
    expect(periodic).toHaveLength(2);
    const measurands = periodic[0]!.meterValue![0]!.sampledValue.map(
      (value) => `${value.measurand}${value.phase ? `.${value.phase}` : ''}`,
    );
    expect(measurands).toEqual([
      'Energy.Active.Import.Register',
      'Power.Active.Import',
      'Current.Import.L1',
      'Current.Import.L2',
      'Current.Import.L3',
      'Voltage.L1-N',
      'Voltage.L2-N',
      'Voltage.L3-N',
      'SoC',
    ]);
    station.stopTransaction(1);
    await advance(0);
    const ended = events(csms).at(-1)!;
    // Three TxEndedInterval samples (20, 40, 60 s) plus the final reading.
    expect(ended.meterValue?.map((value) => value.sampledValue[0]?.context)).toEqual([
      'Sample.Periodic',
      'Sample.Periodic',
      'Sample.Periodic',
      'Transaction.End',
    ]);
  });

  it('reports clock-aligned values in the transaction and, with SendDuringIdle, outside it', async () => {
    const { csms, station } = await started();
    station.deviceModel.set({ component: 'AlignedDataCtrlr', variable: 'Interval' }, '900');
    station.deviceModel.set({ component: 'AlignedDataCtrlr', variable: 'SendDuringIdle' }, 'true');
    await charging(station);
    await advance(1_801);
    expect(
      events(csms).filter((event) => event.triggerReason === 'MeterValueClock').length,
    ).toBeGreaterThanOrEqual(1);
    const idle = csms.requestsOf('MeterValues').filter((request) => request.evseId === 2);
    expect(idle.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(idle[0])).toContain('Sample.Clock');
  });

  it('ends the transaction when the CSMS refuses the token, or only stops energy after MaxEnergyOnInvalidId', async () => {
    const { csms, station } = await started();
    station.deviceModel.set({ component: 'AuthCtrlr', variable: 'LocalPreAuthorize' }, 'true');
    // Cached as Accepted, then refused in the TransactionEventResponse.
    station.authorizationCache.update(
      { idToken: 'BLOCKED', type: 'ISO14443' },
      { status: 'Accepted' },
      3_600,
    );
    station.plugIn(1, EV);
    await station.swipe(1, 'BLOCKED');
    await advance(0);
    await advance(0);
    expect(events(csms).at(-1)).toMatchObject({
      eventType: 'Ended',
      triggerReason: 'Deauthorized',
      transactionInfo: { stoppedReason: 'DeAuthorized' },
    });
    station.unplug(1);
    station.deviceModel.set({ component: 'TxCtrlr', variable: 'StopTxOnInvalidId' }, 'false');
    station.deviceModel.set({ component: 'TxCtrlr', variable: 'MaxEnergyOnInvalidId' }, '100');
    station.authorizationCache.update(
      { idToken: 'BLOCKED', type: 'ISO14443' },
      { status: 'Accepted' },
      3_600,
    );
    station.plugIn(1, EV);
    await station.swipe(1, 'BLOCKED');
    await advance(60);
    const evse = station.evses[0]!;
    expect(evse.transactionId).toBeDefined();
    expect(evse.chargingState).toBe('EVConnected');
    expect(evse.powerW).toBe(0);
  });

  it('refuses unknown tokens offline unless OfflineTxForUnknownIdEnabled, and replays offline events in order', async () => {
    const { csms, station } = await started();
    await csms.drop();
    csms.available = false;
    await advance(0);
    station.plugIn(1, EV);
    expect(await station.swipe(1, 'UNKNOWN')).toBe(false);
    station.deviceModel.set(
      { component: 'AuthCtrlr', variable: 'OfflineTxForUnknownIdEnabled' },
      'true',
    );
    expect(await station.swipe(1, 'UNKNOWN')).toBe(true);
    await advance(90);
    station.stopTransaction(1);
    await advance(0);
    expect(station.queueSize).toBeGreaterThanOrEqual(3);
    expect(events(csms)).toHaveLength(0);
    csms.available = true;
    await advance(5);
    const replayed = events(csms);
    expect(replayed.map((event) => event.seqNo)).toEqual(replayed.map((_, index) => index));
    expect(replayed.every((event) => event.offline === true)).toBe(true);
    expect(replayed[0]?.eventType).toBe('Started');
    expect(replayed.at(-1)?.eventType).toBe('Ended');
    expect(station.queueSize).toBe(0);
  });
});
