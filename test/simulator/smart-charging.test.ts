import { describe, expect, it } from 'vitest';
import { ChargingProfileManager, type ChargingProfile } from '../../src/index.js';

const spec = { voltage: 230, phases: 3 };
const T0 = new Date('2026-05-01T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1_000);
const tx = { transactionId: 42, startedAt: T0 };

function profile(
  overrides: Partial<ChargingProfile> & { limits?: [number, number][] } = {},
): ChargingProfile {
  const { limits = [[0, 16]], ...rest } = overrides;
  return {
    chargingProfileId: 1,
    stackLevel: 0,
    chargingProfilePurpose: 'TxDefaultProfile',
    chargingProfileKind: 'Relative',
    chargingSchedule: {
      chargingRateUnit: 'A',
      chargingSchedulePeriod: limits.map(([startPeriod, limit]) => ({ startPeriod, limit })),
    },
    ...rest,
  };
}

const manager = () => new ChargingProfileManager({ connectors: 2 });

describe('ChargingProfileManager.set', () => {
  it('accepts a TxDefaultProfile and converts amps to watts', () => {
    const m = manager();
    expect(m.set(1, profile(), undefined)).toBe('Accepted');
    expect(m.connectorLimitW(1, T0, tx, spec)).toBe(16 * 230 * 3);
    expect(m.connectorLimitW(2, T0, tx, spec)).toBeUndefined();
  });

  it('honours numberPhases of the active period', () => {
    const m = manager();
    const p = profile();
    p.chargingSchedule.chargingSchedulePeriod[0] = { startPeriod: 0, limit: 16, numberPhases: 1 };
    m.set(1, p, undefined);
    expect(m.connectorLimitW(1, T0, tx, spec)).toBe(16 * 230);
  });

  it('enforces purpose and connector rules', () => {
    const m = manager();
    expect(m.set(1, profile({ chargingProfilePurpose: 'ChargePointMaxProfile' }), undefined)).toBe(
      'Rejected',
    );
    expect(m.set(0, profile({ chargingProfilePurpose: 'ChargePointMaxProfile' }), undefined)).toBe(
      'Accepted',
    );
    expect(m.set(1, profile({ chargingProfilePurpose: 'TxProfile' }), undefined)).toBe('Rejected');
    expect(m.set(0, profile({ chargingProfilePurpose: 'TxProfile' }), tx)).toBe('Rejected');
    expect(m.set(1, profile({ chargingProfilePurpose: 'TxProfile', transactionId: 7 }), tx)).toBe(
      'Rejected',
    );
    expect(
      m.set(1, profile({ chargingProfilePurpose: 'TxProfile', chargingProfileId: 9 }), tx),
    ).toBe('Accepted');
    expect(m.set(3, profile(), undefined)).toBe('Rejected');
    expect(m.set(1, profile({ stackLevel: 9 }), undefined)).toBe('Rejected');
    expect(m.set(1, profile({ limits: [[10, 16]] }), undefined)).toBe('Rejected');
    expect(m.set(1, profile({ chargingProfileKind: 'Recurring' }), undefined)).toBe('Rejected');
  });

  it('replaces profiles with the same id or the same purpose and stack level', () => {
    const m = manager();
    m.set(1, profile({ chargingProfileId: 1, limits: [[0, 10]] }), undefined);
    m.set(1, profile({ chargingProfileId: 1, limits: [[0, 12]] }), undefined);
    expect(m.profiles()).toHaveLength(1);
    m.set(1, profile({ chargingProfileId: 2, limits: [[0, 14]] }), undefined);
    expect(m.profiles()).toHaveLength(1);
    expect(m.profiles()[0]?.profile.chargingProfileId).toBe(2);
    m.set(1, profile({ chargingProfileId: 3, stackLevel: 1, limits: [[0, 6]] }), undefined);
    expect(m.profiles(1)).toHaveLength(2);
  });

  it('limits the number of installed profiles', () => {
    const m = new ChargingProfileManager({ connectors: 2, maxProfiles: 2 });
    expect(m.set(1, profile({ chargingProfileId: 1, stackLevel: 0 }), undefined)).toBe('Accepted');
    expect(m.set(1, profile({ chargingProfileId: 2, stackLevel: 1 }), undefined)).toBe('Accepted');
    expect(m.set(1, profile({ chargingProfileId: 3, stackLevel: 2 }), undefined)).toBe('Rejected');
  });
});

describe('ChargingProfileManager stacking and schedules', () => {
  it('uses the highest valid stack level within a purpose', () => {
    const m = manager();
    m.set(1, profile({ chargingProfileId: 1, stackLevel: 0, limits: [[0, 32]] }), undefined);
    m.set(
      1,
      profile({
        chargingProfileId: 2,
        stackLevel: 5,
        limits: [[0, 10]],
        validTo: at(600).toISOString(),
      }),
      undefined,
    );
    expect(m.connectorLimitW(1, at(0), tx, spec)).toBe(10 * 690);
    // After validTo the lower stack level applies again.
    expect(m.connectorLimitW(1, at(600), tx, spec)).toBe(32 * 690);
  });

  it('lets a TxProfile override TxDefaultProfiles, and connector defaults override connector 0', () => {
    const m = manager();
    m.set(0, profile({ chargingProfileId: 1, limits: [[0, 32]] }), undefined);
    expect(m.connectorLimitW(2, T0, tx, spec)).toBe(32 * 690);
    m.set(2, profile({ chargingProfileId: 2, limits: [[0, 20]] }), undefined);
    expect(m.connectorLimitW(2, T0, tx, spec)).toBe(20 * 690);
    m.set(
      2,
      profile({ chargingProfileId: 3, chargingProfilePurpose: 'TxProfile', limits: [[0, 8]] }),
      tx,
    );
    expect(m.connectorLimitW(2, T0, tx, spec)).toBe(8 * 690);
    m.transactionEnded(2);
    expect(m.connectorLimitW(2, T0, tx, spec)).toBe(20 * 690);
  });

  it('evaluates relative schedules from the transaction start and respects duration', () => {
    const m = manager();
    const p = profile({
      limits: [
        [0, 6],
        [300, 16],
      ],
    });
    p.chargingSchedule.duration = 900;
    m.set(1, p, undefined);
    expect(m.connectorLimitW(1, at(299), tx, spec)).toBe(6 * 690);
    expect(m.connectorLimitW(1, at(300), tx, spec)).toBe(16 * 690);
    expect(m.connectorLimitW(1, at(900), tx, spec)).toBeUndefined();
  });

  it('evaluates absolute schedules from startSchedule', () => {
    const m = manager();
    const p = profile({
      chargingProfileKind: 'Absolute',
      limits: [
        [0, 11_000],
        [3_600, 0],
      ],
    });
    p.chargingSchedule.chargingRateUnit = 'W';
    p.chargingSchedule.startSchedule = at(60).toISOString();
    m.set(1, p, undefined);
    expect(m.connectorLimitW(1, at(0), undefined, spec)).toBeUndefined();
    expect(m.connectorLimitW(1, at(60), undefined, spec)).toBe(11_000);
    expect(m.connectorLimitW(1, at(3_660), undefined, spec)).toBe(0);
  });

  it('runs an absolute schedule without startSchedule from the start of charging', () => {
    // Regression: the schedule used to start when the profile was received.
    const m = manager();
    const p = profile({
      chargingProfileKind: 'Absolute',
      limits: [
        [0, 16],
        [600, 8],
      ],
    });
    m.set(1, p, undefined, T0);
    const lateTx = { transactionId: 43, startedAt: at(300) };
    expect(m.connectorLimitW(1, at(700), lateTx, spec)).toBe(16 * 690);
    expect(m.connectorLimitW(1, at(900), lateTx, spec)).toBe(8 * 690);
    // Outside a transaction the moment of installation is the only reference point.
    expect(m.connectorLimitW(1, at(700), undefined, spec)).toBe(8 * 690);
  });

  it('evaluates daily recurring schedules', () => {
    const m = manager();
    const p = profile({
      chargingProfileKind: 'Recurring',
      recurrencyKind: 'Daily',
      limits: [
        [0, 6],
        [8 * 3_600, 32],
      ],
    });
    p.chargingSchedule.startSchedule = '2026-01-01T00:00:00.000Z';
    m.set(1, p, undefined);
    expect(m.connectorLimitW(1, new Date('2026-05-01T07:59:59Z'), undefined, spec)).toBe(6 * 690);
    expect(m.connectorLimitW(1, new Date('2026-05-01T08:00:00Z'), undefined, spec)).toBe(32 * 690);
    expect(m.connectorLimitW(1, new Date('2026-05-02T01:00:00Z'), undefined, spec)).toBe(6 * 690);
  });

  it('ignores profiles outside validFrom', () => {
    const m = manager();
    m.set(1, profile({ validFrom: at(100).toISOString() }), undefined);
    expect(m.connectorLimitW(1, at(99), tx, spec)).toBeUndefined();
    expect(m.connectorLimitW(1, at(100), tx, spec)).toBe(16 * 690);
  });

  it('reports the station-wide cap separately', () => {
    const m = manager();
    m.set(
      0,
      profile({
        chargingProfilePurpose: 'ChargePointMaxProfile',
        chargingProfileKind: 'Absolute',
        limits: [[0, 32]],
      }),
      undefined,
      T0,
    );
    expect(m.stationLimitW(T0, spec)).toBe(32 * 690);
    expect(m.connectorLimitW(1, T0, tx, spec)).toBeUndefined();
  });
});

describe('ChargingProfileManager.clear', () => {
  it('clears by id or by matching criteria', () => {
    const m = manager();
    m.set(1, profile({ chargingProfileId: 1, stackLevel: 0 }), undefined);
    m.set(1, profile({ chargingProfileId: 2, stackLevel: 1 }), undefined);
    m.set(2, profile({ chargingProfileId: 3, stackLevel: 1 }), undefined);
    expect(m.clear({ id: 99 })).toBe('Unknown');
    expect(m.clear({ id: 1 })).toBe('Accepted');
    expect(m.clear({ connectorId: 2, stackLevel: 0 })).toBe('Unknown');
    expect(m.clear({ connectorId: 2, chargingProfilePurpose: 'TxDefaultProfile' })).toBe(
      'Accepted',
    );
    expect(m.profiles().map((p) => p.profile.chargingProfileId)).toEqual([2]);
    expect(m.clear({})).toBe('Accepted');
    expect(m.profiles()).toEqual([]);
  });
});

describe('ChargingProfileManager.compositeSchedule', () => {
  it('merges profiles into one schedule including the hardware limit', () => {
    const m = manager();
    const p = profile({
      limits: [
        [0, 10],
        [600, 40],
      ],
    });
    p.chargingSchedule.duration = 1_200;
    m.set(1, p, undefined);
    m.set(
      0,
      profile({
        chargingProfileId: 5,
        chargingProfilePurpose: 'ChargePointMaxProfile',
        chargingProfileKind: 'Absolute',
        limits: [[0, 20]],
      }),
      undefined,
      T0,
    );
    const result = m.compositeSchedule(1, 1_800, {
      now: T0,
      transaction: tx,
      hardwareMaxW: 32 * 690,
      spec,
      unit: 'A',
    });
    expect(result).toMatchObject({
      status: 'Accepted',
      connectorId: 1,
      scheduleStart: T0.toISOString(),
      chargingSchedule: {
        duration: 1_800,
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [
          { startPeriod: 0, limit: 10 },
          { startPeriod: 600, limit: 20 },
        ],
      },
    });
  });

  it('reports watts by default and falls back to the hardware maximum', () => {
    const m = manager();
    const result = m.compositeSchedule(2, 60, { now: T0, hardwareMaxW: 11_000, spec });
    expect(result.chargingSchedule).toMatchObject({
      chargingRateUnit: 'W',
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 11_000 }],
    });
    expect(m.compositeSchedule(3, 60, { now: T0, hardwareMaxW: 1, spec })).toEqual({
      status: 'Rejected',
    });
  });

  it('includes recurring boundaries inside the window', () => {
    const m = manager();
    const p = profile({
      chargingProfileKind: 'Recurring',
      recurrencyKind: 'Daily',
      limits: [
        [0, 6],
        [13 * 3_600, 16],
      ],
    });
    p.chargingSchedule.chargingRateUnit = 'A';
    p.chargingSchedule.startSchedule = '2026-01-01T00:00:00.000Z';
    m.set(1, p, undefined);
    const result = m.compositeSchedule(1, 2 * 86_400, {
      now: T0,
      hardwareMaxW: 32 * 690,
      spec,
      unit: 'A',
    });
    expect(result.chargingSchedule?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 6 },
      { startPeriod: 3_600, limit: 16 },
      { startPeriod: 12 * 3_600, limit: 6 },
      { startPeriod: 25 * 3_600, limit: 16 },
      { startPeriod: 36 * 3_600, limit: 6 },
    ]);
  });

  it('never reports two periods with the same startPeriod (regression)', () => {
    // A transaction started at .600 and an absolute schedule on whole seconds put two
    // breakpoints within one second of each other: 5.6 s and 6 s after "now".
    const m = new ChargingProfileManager({ connectors: 1 });
    const now = new Date('2026-05-01T12:00:05.000Z');
    const running = { transactionId: 1, startedAt: new Date('2026-05-01T12:00:00.600Z') };
    m.set(
      1,
      profile({
        chargingSchedule: {
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [
            { startPeriod: 0, limit: 5_000 },
            { startPeriod: 10, limit: 4_000 },
          ],
        },
      }),
      running,
      now,
    );
    m.set(
      0,
      profile({
        chargingProfileId: 2,
        chargingProfilePurpose: 'ChargePointMaxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: {
          startSchedule: '2026-05-01T12:00:00.000Z',
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [
            { startPeriod: 0, limit: 9_000 },
            { startPeriod: 11, limit: 3_000 },
          ],
        },
      }),
      undefined,
      now,
    );
    const result = m.compositeSchedule(1, 60, {
      now,
      transaction: running,
      hardwareMaxW: 22_000,
      spec,
    });
    expect(result.chargingSchedule?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 5_000 },
      { startPeriod: 6, limit: 3_000 },
    ]);
  });
});
