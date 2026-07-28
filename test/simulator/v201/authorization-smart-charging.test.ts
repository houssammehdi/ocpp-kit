import { describe, expect, it } from 'vitest';
import {
  authorizeIdToken,
  ChargingProfileManager201,
  IdTokenCache,
  IdTokenLocalList,
  idTokenKey,
  sameIdTokenGroup,
  type IdTokenPolicy,
  type v201,
} from '../../../src/index.js';
import { advance, charging, EV, events, started, trace, useSimulatedTime } from './harness.js';

const tok = (idToken: string, type: v201.IdToken['type'] = 'ISO14443'): v201.IdToken => ({
  idToken,
  type,
});
const T0 = new Date('2026-05-01T12:00:00.000Z');
const POLICY: IdTokenPolicy = {
  authorizationEnabled: true,
  localListEnabled: true,
  cacheEnabled: true,
  localPreAuthorize: false,
  localAuthorizeOffline: true,
  offlineTxForUnknownId: false,
  cacheLifetimeS: 3_600,
};

describe('2.0.1 authorization', () => {
  it('identifies idTokens by type and case-insensitive value, groups by groupIdToken', () => {
    expect(idTokenKey(tok('AbC'))).toBe(idTokenKey(tok('abc')));
    expect(idTokenKey(tok('abc'))).not.toBe(idTokenKey(tok('abc', 'Central')));
    const group = tok('FLEET', 'Central');
    expect(sameIdTokenGroup({ token: tok('A'), group }, { token: tok('B'), group })).toBe(true);
    expect(sameIdTokenGroup({ token: tok('A') }, { token: tok('B') })).toBe(false);
  });

  it('expires cache entries at cacheExpiryDateTime or after the lifetime, and evicts refused ones first', () => {
    const cache = new IdTokenCache(2);
    cache.update(
      tok('A'),
      { status: 'Accepted', cacheExpiryDateTime: '2026-05-01T12:10:00.000Z' },
      60,
      T0,
    );
    cache.update(tok('B'), { status: 'Blocked' }, 60, T0);
    expect(cache.get(tok('A'), new Date(T0.getTime() + 5 * 60_000))?.status).toBe('Accepted');
    expect(cache.get(tok('B'), new Date(T0.getTime() + 61_000))).toBeUndefined();
    cache.update(tok('B'), { status: 'Blocked' }, 60, T0);
    cache.update(tok('C'), { status: 'Accepted' }, 60, T0);
    expect(cache.get(tok('B'), T0)).toBeUndefined();
    expect(cache.get(tok('A'), T0)?.status).toBe('Accepted');
    expect(cache.get(tok('A'), new Date('2026-05-01T12:10:00.000Z'))).toBeUndefined();
  });

  it('applies full and differential local list updates atomically', () => {
    const list = new IdTokenLocalList({ capacity: 2, itemsPerMessage: () => 3 });
    const entry = (idToken: string, status?: v201.AuthorizationStatus): v201.AuthorizationData => ({
      idToken: tok(idToken),
      ...(status === undefined ? {} : { idTokenInfo: { status } }),
    });
    expect(list.version).toBe(0);
    expect(
      list.apply({
        versionNumber: 1,
        updateType: 'Full',
        localAuthorizationList: [entry('A', 'Accepted')],
      }),
    ).toBe('Accepted');
    expect(list.version).toBe(1);
    expect(
      list.apply({
        versionNumber: 1,
        updateType: 'Differential',
        localAuthorizationList: [entry('B', 'Accepted')],
      }),
    ).toBe('VersionMismatch');
    expect(
      list.apply({
        versionNumber: 2,
        updateType: 'Differential',
        localAuthorizationList: [entry('B', 'Blocked'), entry('A')],
      }),
    ).toBe('Accepted');
    expect(list.get(tok('a'))).toBeUndefined();
    expect(list.get(tok('B'))?.status).toBe('Blocked');
    expect(
      list.apply({ versionNumber: 3, updateType: 'Full', localAuthorizationList: [entry('A')] }),
    ).toBe('Failed');
    expect(
      list.apply({
        versionNumber: 3,
        updateType: 'Full',
        localAuthorizationList: [entry('A', 'Accepted'), entry('a', 'Accepted')],
      }),
    ).toBe('Failed');
    expect(
      list.apply({
        versionNumber: 3,
        updateType: 'Full',
        localAuthorizationList: [
          entry('A', 'Accepted'),
          entry('B', 'Accepted'),
          entry('C', 'Accepted'),
        ],
      }),
    ).toBe('Failed');
    expect(
      list.apply({
        versionNumber: 3,
        updateType: 'Full',
        localAuthorizationList: ['A', 'B', 'C', 'D'].map((t) => entry(t, 'Accepted')),
      }),
    ).toBe('Failed');
    expect(list.apply({ versionNumber: 4, updateType: 'Full' })).toBe('Accepted');
    expect(list.version).toBe(0);
  });

  it('decides like AuthCtrlr says: local list first, pre-authorization, offline rules', async () => {
    const localList = new IdTokenLocalList();
    localList.apply({
      versionNumber: 1,
      updateType: 'Full',
      localAuthorizationList: [{ idToken: tok('LISTED'), idTokenInfo: { status: 'Accepted' } }],
    });
    const cache = new IdTokenCache();
    const asked: string[] = [];
    const context = (online: boolean, policy: Partial<IdTokenPolicy> = {}) => ({
      online,
      policy: { ...POLICY, ...policy },
      localList,
      cache,
      now: T0,
      askCsms: (token: v201.IdToken) => {
        asked.push(token.idToken);
        return Promise.resolve({
          kind: 'answered' as const,
          idTokenInfo: {
            status: token.idToken === 'BAD' ? ('Invalid' as const) : ('Accepted' as const),
          },
        });
      },
    });
    expect(
      await authorizeIdToken(tok('LISTED'), context(true, { localPreAuthorize: true })),
    ).toMatchObject({ accepted: true, source: 'LocalList' });
    expect(asked).toEqual([]);
    expect(await authorizeIdToken(tok('NEW'), context(true))).toMatchObject({
      accepted: true,
      source: 'Csms',
    });
    expect(cache.get(tok('NEW'), T0)?.status).toBe('Accepted');
    expect(await authorizeIdToken(tok('BAD'), context(true))).toMatchObject({
      accepted: false,
      source: 'Csms',
    });
    expect(await authorizeIdToken(tok('NEW'), context(false))).toMatchObject({
      accepted: true,
      source: 'Cache',
    });
    expect(
      await authorizeIdToken(tok('NEW'), context(false, { localAuthorizeOffline: false })),
    ).toMatchObject({ accepted: false });
    expect(await authorizeIdToken(tok('STRANGER'), context(false))).toMatchObject({
      accepted: false,
      source: 'OfflineUnknown',
    });
    expect(
      await authorizeIdToken(tok('STRANGER'), context(false, { offlineTxForUnknownId: true })),
    ).toMatchObject({ accepted: true });
    expect(
      await authorizeIdToken(tok('ANY'), context(false, { authorizationEnabled: false })),
    ).toMatchObject({ accepted: true, source: 'Disabled' });
    expect(await authorizeIdToken(tok('ANY', 'NoAuthorization'), context(false))).toMatchObject({
      accepted: true,
    });
    const error = { ...context(true), askCsms: () => Promise.resolve({ kind: 'error' as const }) };
    expect(await authorizeIdToken(tok('X'), error)).toMatchObject({
      accepted: false,
      source: 'CsmsError',
    });
  });
});

describe('ChargingProfileManager201', () => {
  const spec = { voltage: 230, phases: 3 };
  const tx = { transactionId: 'tx-1', startedAt: T0 };
  const profile = (
    overrides: Partial<v201.ChargingProfile> = {},
    limit = 16,
    unit: 'A' | 'W' = 'A',
  ): v201.ChargingProfile => ({
    id: 1,
    stackLevel: 0,
    chargingProfilePurpose: 'TxDefaultProfile',
    chargingProfileKind: 'Relative',
    chargingSchedule: [
      { id: 1, chargingRateUnit: unit, chargingSchedulePeriod: [{ startPeriod: 0, limit }] },
    ],
    ...overrides,
  });
  const manager = () => new ChargingProfileManager201({ evses: 2 });

  it('enforces the K01 rules for purposes, EVSEs and transactions', () => {
    const m = manager();
    const reason = (r: v201.SetChargingProfileResponse) => r.statusInfo?.reasonCode ?? r.status;
    expect(
      reason(
        m.set(
          1,
          profile({ chargingProfilePurpose: 'ChargingStationExternalConstraints' }),
          undefined,
        ),
      ),
    ).toBe('InvalidValue');
    expect(
      reason(
        m.set(
          1,
          profile({
            chargingProfilePurpose: 'ChargingStationMaxProfile',
            chargingProfileKind: 'Absolute',
          }),
          undefined,
        ),
      ),
    ).toBe('InvalidValue');
    expect(
      reason(m.set(0, profile({ chargingProfilePurpose: 'ChargingStationMaxProfile' }), undefined)),
    ).toBe('InvalidValue'); // Relative
    expect(
      reason(
        m.set(
          0,
          profile({ chargingProfilePurpose: 'TxProfile', transactionId: 'tx-1' }),
          undefined,
        ),
      ),
    ).toBe('InvalidValue');
    expect(reason(m.set(1, profile({ chargingProfilePurpose: 'TxProfile' }), tx))).toBe(
      'InvalidValue',
    );
    expect(
      reason(
        m.set(1, profile({ chargingProfilePurpose: 'TxProfile', transactionId: 'other' }), tx),
      ),
    ).toBe('TxNotFound');
    expect(
      m.set(1, profile({ chargingProfilePurpose: 'TxProfile', transactionId: 'tx-1' }), tx).status,
    ).toBe('Accepted');
    expect(reason(m.set(3, profile(), undefined))).toBe('UnknownEvse');
    expect(reason(m.set(1, profile({ stackLevel: 9 }), undefined))).toBe('InvalidStackLevel');
    expect(reason(m.set(1, profile({ chargingProfileKind: 'Recurring' }), undefined))).toBe(
      'InvalidSchedule',
    );
    const badPeriods = profile();
    badPeriods.chargingSchedule[0]!.chargingSchedulePeriod = [{ startPeriod: 10, limit: 6 }];
    expect(reason(m.set(1, badPeriods, undefined))).toBe('InvalidSchedule');
    const phaseToUse = profile();
    phaseToUse.chargingSchedule[0]!.chargingSchedulePeriod = [
      { startPeriod: 0, limit: 6, numberPhases: 3, phaseToUse: 1 },
    ];
    expect(reason(m.set(1, phaseToUse, undefined))).toBe('InvalidSchedule');
  });

  it('replaces a profile with the same id but refuses a different one at the same stack level', () => {
    const m = manager();
    expect(m.set(1, profile({ id: 1 }), undefined).status).toBe('Accepted');
    expect(m.set(1, profile({ id: 1 }, 10), undefined).status).toBe('Accepted');
    expect(m.size).toBe(1);
    expect(m.set(1, profile({ id: 2 }), undefined)).toMatchObject({
      status: 'Rejected',
      statusInfo: { reasonCode: 'DuplicateProfile' },
    });
    // Profile 1 has no validTo, so it overlaps one that starts later; disjoint periods are fine.
    expect(
      m.set(1, profile({ id: 3, validFrom: '2030-01-01T00:00:00.000Z' }), undefined).status,
    ).toBe('Rejected');
    const bounded = new ChargingProfileManager201({ evses: 2 });
    bounded.set(1, profile({ id: 1, validTo: '2026-06-01T00:00:00.000Z' }), undefined);
    expect(
      bounded.set(1, profile({ id: 2, validFrom: '2026-06-01T00:00:00.000Z' }), undefined).status,
    ).toBe('Accepted');
    // Another EVSE or stack level is fine.
    expect(m.set(2, profile({ id: 4 }), undefined).status).toBe('Accepted');
    expect(m.set(1, profile({ id: 5, stackLevel: 1 }), undefined).status).toBe('Accepted');
  });

  it('stacks purposes: TxProfile over TxDefault, EVSE over station default, capped by max and external limits', () => {
    const m = manager();
    m.set(0, profile({ id: 1 }, 32), undefined);
    expect(m.evseLimitW(1, T0, undefined, spec)).toBe(32 * 690);
    m.set(1, profile({ id: 2 }, 16), undefined);
    expect(m.evseLimitW(1, T0, undefined, spec)).toBe(16 * 690);
    expect(m.evseLimitW(2, T0, undefined, spec)).toBe(32 * 690);
    m.set(
      1,
      profile({ id: 3, chargingProfilePurpose: 'TxProfile', transactionId: 'tx-1' }, 10),
      tx,
    );
    expect(m.evseLimitW(1, T0, tx, spec)).toBe(10 * 690);
    m.setExternal(
      1,
      profile({ id: 4, chargingProfilePurpose: 'ChargingStationExternalConstraints' }, 6),
    );
    expect(m.evseLimitW(1, T0, tx, spec)).toBe(6 * 690);
    m.set(
      0,
      profile(
        {
          id: 5,
          chargingProfilePurpose: 'ChargingStationMaxProfile',
          chargingProfileKind: 'Absolute',
        },
        20_000,
        'W',
      ),
      undefined,
      T0,
    );
    expect(m.stationLimitW(T0, spec)).toBe(20_000);
    m.setExternal(
      0,
      profile({ id: 6, chargingProfilePurpose: 'ChargingStationExternalConstraints' }, 12_000, 'W'),
    );
    expect(m.stationLimitW(T0, spec)).toBe(12_000);
    // ClearChargingProfile never removes external constraints.
    expect(
      m.clear({
        chargingProfileCriteria: { chargingProfilePurpose: 'ChargingStationExternalConstraints' },
      }).status,
    ).toBe('Unknown');
    expect(m.clear({ chargingProfileId: 3 }).status).toBe('Accepted');
    expect(m.clearExternal(1)).toBe(true);
    m.transactionEnded(1);
    expect(m.evseLimitW(1, T0, undefined, spec)).toBe(16 * 690);
  });

  it('selects profiles for GetChargingProfiles grouped by EVSE and source, and composes schedules', () => {
    const m = manager();
    m.set(0, profile({ id: 1 }, 32), undefined);
    m.set(1, profile({ id: 2, stackLevel: 1 }, 16), undefined);
    m.setExternal(
      1,
      profile({ id: 3, chargingProfilePurpose: 'ChargingStationExternalConstraints' }, 10),
    );
    const groups = m.select({ requestId: 1, chargingProfile: {} });
    expect(groups.map((g) => g.map((p) => `${p.evseId}/${p.source}/${p.profile.id}`))).toEqual([
      ['0/CSO/1'],
      ['1/CSO/2'],
      ['1/EMS/3'],
    ]);
    expect(
      m
        .select({ requestId: 1, evseId: 1, chargingProfile: { chargingLimitSource: ['CSO'] } })
        .flat()
        .map((p) => p.profile.id),
    ).toEqual([2]);
    expect(m.select({ requestId: 1, chargingProfile: { chargingProfileId: [9] } })).toEqual([]);
    const composite = m.compositeSchedule(
      { evseId: 1, duration: 600, chargingRateUnit: 'A' },
      { now: T0, hardwareMaxW: 22_000, spec },
    );
    expect(composite).toEqual({
      status: 'Accepted',
      schedule: {
        evseId: 1,
        duration: 600,
        scheduleStart: T0.toISOString(),
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 10 }],
      },
    });
    expect(m.compositeSchedule({ evseId: 5, duration: 60 }, { hardwareMaxW: 1, spec }).status).toBe(
      'Rejected',
    );
  });
});

describe('a simulated 2.0.1 station', () => {
  useSimulatedTime();

  it('authorizes from its local list offline and clears the cache on request', async () => {
    const { csms, station } = await started();
    const peer = csms.current!;
    expect(
      await peer.call('SendLocalList', {
        versionNumber: 5,
        updateType: 'Full',
        localAuthorizationList: [{ idToken: tok('LOCAL-1'), idTokenInfo: { status: 'Accepted' } }],
      }),
    ).toEqual({ status: 'Accepted' });
    expect(await peer.call('GetLocalListVersion', {})).toEqual({ versionNumber: 5 });
    await charging(station, 1, EV, 'CACHED');
    station.stopTransaction(1);
    station.unplug(1);
    expect(await peer.call('ClearCache', {})).toEqual({ status: 'Accepted' });
    expect(station.authorizationCache.size).toBe(0);
    await csms.drop();
    csms.available = false;
    await advance(0);
    station.plugIn(2, EV);
    expect(await station.swipe(2, 'CACHED')).toBe(false);
    expect(await station.swipe(2, 'LOCAL-1')).toBe(true);
  });

  it('honours a charging limit, reports the rate change and answers composite schedules', async () => {
    const { csms, station } = await started();
    await charging(station, 1, { ...EV, maxPowerW: 22_000 });
    await advance(2);
    expect(station.evses[0]?.powerW).toBe(22_000);
    const peer = csms.current!;
    const set = await peer.call('SetChargingProfile', {
      evseId: 1,
      chargingProfile: {
        id: 11,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Relative',
        chargingSchedule: [
          { id: 1, chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 10 }] },
        ],
      },
    });
    expect(set).toEqual({ status: 'Accepted' });
    await advance(2);
    expect(station.evses[0]?.powerW).toBe(6_900);
    expect(trace(csms)).toContain('Updated/ChargingRateChanged');
    const composite = await peer.call('GetCompositeSchedule', { evseId: 1, duration: 300 });
    expect(composite.schedule?.chargingSchedulePeriod).toEqual([{ startPeriod: 0, limit: 6_900 }]);
    expect(await peer.call('GetChargingProfiles', { requestId: 3, chargingProfile: {} })).toEqual({
      status: 'Accepted',
    });
    await advance(0);
    expect(csms.requestsOf('ReportChargingProfiles')).toMatchObject([
      { requestId: 3, evseId: 1, chargingLimitSource: 'CSO', chargingProfile: [{ id: 11 }] },
    ]);
    // A station-wide maximum shared between two EVSEs.
    await charging(station, 2, { ...EV, maxPowerW: 22_000 }, 'TOKEN-2');
    await peer.call('ClearChargingProfile', { chargingProfileId: 11 });
    await peer.call('SetChargingProfile', {
      evseId: 0,
      chargingProfile: {
        id: 12,
        stackLevel: 0,
        chargingProfilePurpose: 'ChargingStationMaxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: [
          {
            id: 1,
            startSchedule: new Date().toISOString(),
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 16_000 }],
          },
        ],
      },
    });
    await advance(2);
    expect(station.evses.map((e) => e.powerW)).toEqual([8_000, 8_000]);
    // An external limit (energy management system) is reported to the CSMS.
    station.setExternalLimit(2, 3_000);
    await advance(2);
    expect(station.evses.map((e) => e.powerW)).toEqual([13_000, 3_000]);
    expect(csms.requestsOf('NotifyChargingLimit')[0]).toMatchObject({
      evseId: 2,
      chargingLimit: { chargingLimitSource: 'EMS' },
    });
    station.setExternalLimit(2, undefined);
    await advance(0);
    expect(csms.requestsOf('ClearedChargingLimit')).toEqual([
      { chargingLimitSource: 'EMS', evseId: 2 },
    ]);
  });

  it('caps power at the installer-set MaxSet of an EVSE and refuses profiles when smart charging is off', async () => {
    const { csms, station } = await started();
    station.deviceModel.set(
      { component: 'EVSE', evse: { id: 1 }, variable: 'Power' },
      '7400',
      'MaxSet',
    );
    await charging(station, 1, { ...EV, maxPowerW: 22_000 });
    await advance(2);
    expect(station.evses[0]?.powerW).toBe(7_400);
    station.deviceModel.set({ component: 'SmartChargingCtrlr', variable: 'Enabled' }, 'false');
    expect(
      await csms.current!.call('SetChargingProfile', {
        evseId: 0,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Relative',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 1 }],
            },
          ],
        },
      }),
    ).toMatchObject({ status: 'Rejected' });
    expect(events(csms)[0]?.eventType).toBe('Started');
  });
});
