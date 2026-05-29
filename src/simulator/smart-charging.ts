import type {
  ChargingProfile,
  ChargingProfilePurpose,
  ChargingProfileStatus,
  ChargingRateUnit,
  ChargingSchedulePeriod,
  ClearChargingProfileRequest,
  ClearChargingProfileStatus,
  GetCompositeScheduleResponse,
} from '../messages/index.js';

/** Electrical parameters used to convert between A and W limits. */
export interface ElectricalSpec {
  /** Phase-to-neutral voltage. */
  readonly voltage: number;
  /** Number of phases wired to the connector. */
  readonly phases: number;
}

/** Transaction context of a connector at evaluation time. */
export interface TransactionContext {
  readonly transactionId: number;
  readonly startedAt: Date;
}

interface Installed {
  readonly connectorId: number;
  readonly profile: ChargingProfile;
  /**
   * When the profile was installed: the schedule start of an Absolute profile without
   * startSchedule that is evaluated outside a transaction (e.g. a ChargePointMaxProfile).
   */
  readonly receivedAt: Date;
}

const DAY_MS = 86_400_000;

/** A limit evaluated at an instant, always expressed in watts. */
interface Limit {
  readonly watts: number;
  readonly numberPhases: number | undefined;
}

function toWatts(
  limit: number,
  unit: ChargingRateUnit,
  phases: number,
  spec: ElectricalSpec,
): number {
  return unit === 'W' ? limit : limit * spec.voltage * phases;
}

function fromWatts(
  watts: number,
  unit: ChargingRateUnit,
  phases: number,
  spec: ElectricalSpec,
): number {
  return unit === 'W' ? watts : watts / (spec.voltage * phases);
}

/** Start instant of the schedule instance that is (or was last) active at `at`. */
function scheduleStart(
  entry: Installed,
  at: Date,
  tx: TransactionContext | undefined,
): Date | undefined {
  const { profile } = entry;
  const { startSchedule } = profile.chargingSchedule;
  switch (profile.chargingProfileKind) {
    case 'Absolute':
      // OCPP 1.6 ChargingSchedule.startSchedule: "If absent the schedule will be relative to
      // start of charging." Without a transaction there is no such start, so fall back to the
      // moment the profile was installed.
      if (startSchedule) return new Date(startSchedule);
      return tx?.startedAt ?? entry.receivedAt;
    case 'Relative':
      return tx?.startedAt ?? at;
    case 'Recurring': {
      if (!startSchedule) return undefined;
      const period = profile.recurrencyKind === 'Weekly' ? 7 * DAY_MS : DAY_MS;
      const origin = new Date(startSchedule).getTime();
      const cycles = Math.floor((at.getTime() - origin) / period);
      return new Date(origin + cycles * period);
    }
  }
}

function isValidAt(profile: ChargingProfile, at: Date): boolean {
  if (profile.validFrom && at < new Date(profile.validFrom)) return false;
  if (profile.validTo && at >= new Date(profile.validTo)) return false;
  return true;
}

/** Evaluate one profile at `at`; `undefined` when it does not constrain that instant. */
function evaluate(
  entry: Installed,
  at: Date,
  tx: TransactionContext | undefined,
  spec: ElectricalSpec,
): Limit | undefined {
  const { profile } = entry;
  if (!isValidAt(profile, at)) return undefined;
  const start = scheduleStart(entry, at, tx);
  if (!start) return undefined;
  const elapsedS = (at.getTime() - start.getTime()) / 1_000;
  const schedule = profile.chargingSchedule;
  if (elapsedS < 0) return undefined;
  if (schedule.duration !== undefined && elapsedS >= schedule.duration) return undefined;
  let active: ChargingSchedulePeriod | undefined;
  for (const period of schedule.chargingSchedulePeriod) {
    if (period.startPeriod <= elapsedS && (!active || period.startPeriod >= active.startPeriod)) {
      active = period;
    }
  }
  if (!active) return undefined;
  const phases = active.numberPhases ?? spec.phases;
  return {
    watts: toWatts(active.limit, schedule.chargingRateUnit, phases, spec),
    numberPhases: active.numberPhases,
  };
}

function minLimit(a: Limit | undefined, b: Limit | undefined): Limit | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.watts <= b.watts ? a : b;
}

/** Options of {@link ChargingProfileManager}. */
export interface ChargingProfileManagerOptions {
  /** Number of physical connectors (ids 1..n). */
  readonly connectors: number;
  /** Highest accepted stack level (`ChargeProfileMaxStackLevel`). Default: 8. */
  readonly maxStackLevel?: number;
  /** Maximum number of installed profiles (`MaxChargingProfilesInstalled`). Default: 16. */
  readonly maxProfiles?: number;
  /** Maximum schedule periods per profile (`ChargingScheduleMaxPeriods`). Default: 24. */
  readonly maxPeriods?: number;
}

/**
 * Stores charging profiles and evaluates them following the OCPP 1.6 stacking rules:
 *
 * - Within a purpose, the valid profile with the highest `stackLevel` wins.
 * - A `TxProfile` overrides `TxDefaultProfile`s; a connector-specific `TxDefaultProfile`
 *   overrides one installed on connector 0.
 * - `ChargePointMaxProfile` (connector 0 only) caps the charge point as a whole.
 */
export class ChargingProfileManager {
  readonly #options: Required<ChargingProfileManagerOptions>;
  #installed: Installed[] = [];

  constructor(options: ChargingProfileManagerOptions) {
    this.#options = { maxStackLevel: 8, maxProfiles: 16, maxPeriods: 24, ...options };
  }

  /** Installed profiles, optionally filtered by connector. */
  profiles(connectorId?: number): { connectorId: number; profile: ChargingProfile }[] {
    return this.#installed
      .filter((entry) => connectorId === undefined || entry.connectorId === connectorId)
      .map(({ connectorId: id, profile }) => ({ connectorId: id, profile }));
  }

  /**
   * Handle SetChargingProfile.
   *
   * @param activeTransaction - the transaction running on `connectorId`, if any
   */
  set(
    connectorId: number,
    profile: ChargingProfile,
    activeTransaction: TransactionContext | undefined,
    now: Date = new Date(),
  ): ChargingProfileStatus {
    const { chargingProfilePurpose: purpose, chargingSchedule: schedule } = profile;
    if (connectorId < 0 || connectorId > this.#options.connectors) return 'Rejected';
    if (profile.stackLevel > this.#options.maxStackLevel) return 'Rejected';
    if (schedule.chargingSchedulePeriod.length > this.#options.maxPeriods) return 'Rejected';
    if (purpose === 'ChargePointMaxProfile' && connectorId !== 0) return 'Rejected';
    if (purpose === 'TxProfile') {
      if (connectorId === 0 || !activeTransaction) return 'Rejected';
      if (
        profile.transactionId !== undefined &&
        profile.transactionId !== activeTransaction.transactionId
      ) {
        return 'Rejected';
      }
    }
    if (
      profile.chargingProfileKind === 'Recurring' &&
      (!profile.recurrencyKind || !schedule.startSchedule)
    ) {
      return 'Rejected';
    }
    const periods = [...schedule.chargingSchedulePeriod].sort(
      (a, b) => a.startPeriod - b.startPeriod,
    );
    if (periods[0]?.startPeriod !== 0) return 'Rejected';

    const remaining = this.#installed.filter(
      (entry) =>
        entry.profile.chargingProfileId !== profile.chargingProfileId &&
        !(
          entry.connectorId === connectorId &&
          entry.profile.chargingProfilePurpose === purpose &&
          entry.profile.stackLevel === profile.stackLevel
        ),
    );
    if (remaining.length >= this.#options.maxProfiles) return 'Rejected';
    const stored: ChargingProfile =
      purpose === 'TxProfile' && activeTransaction
        ? { ...profile, transactionId: activeTransaction.transactionId }
        : profile;
    this.#installed = [...remaining, { connectorId, profile: stored, receivedAt: now }];
    return 'Accepted';
  }

  /** Handle ClearChargingProfile. All given criteria must match. */
  clear(criteria: ClearChargingProfileRequest): ClearChargingProfileStatus {
    const matches = (entry: Installed): boolean => {
      if (criteria.id !== undefined) return entry.profile.chargingProfileId === criteria.id;
      if (criteria.connectorId !== undefined && entry.connectorId !== criteria.connectorId)
        return false;
      if (
        criteria.chargingProfilePurpose !== undefined &&
        entry.profile.chargingProfilePurpose !== criteria.chargingProfilePurpose
      ) {
        return false;
      }
      if (criteria.stackLevel !== undefined && entry.profile.stackLevel !== criteria.stackLevel) {
        return false;
      }
      return true;
    };
    const before = this.#installed.length;
    this.#installed = this.#installed.filter((entry) => !matches(entry));
    return this.#installed.length < before ? 'Accepted' : 'Unknown';
  }

  /** Remove TxProfiles bound to a finished transaction (they only live as long as it). */
  transactionEnded(connectorId: number): void {
    this.#installed = this.#installed.filter(
      (entry) =>
        !(
          entry.connectorId === connectorId && entry.profile.chargingProfilePurpose === 'TxProfile'
        ),
    );
  }

  #winner(
    connectorId: number,
    purpose: ChargingProfilePurpose,
    at: Date,
    tx: TransactionContext | undefined,
    spec: ElectricalSpec,
  ): Limit | undefined {
    const candidates = this.#installed
      .filter((e) => e.connectorId === connectorId && e.profile.chargingProfilePurpose === purpose)
      .sort((a, b) => b.profile.stackLevel - a.profile.stackLevel);
    for (const entry of candidates) {
      const limit = evaluate(entry, at, tx, spec);
      if (limit) return limit;
    }
    return undefined;
  }

  #transactionLimit(
    connectorId: number,
    at: Date,
    tx: TransactionContext | undefined,
    spec: ElectricalSpec,
  ): Limit | undefined {
    if (connectorId > 0 && tx) {
      const txLimit = this.#winner(connectorId, 'TxProfile', at, tx, spec);
      if (txLimit) return txLimit;
    }
    if (connectorId > 0) {
      const own = this.#winner(connectorId, 'TxDefaultProfile', at, tx, spec);
      if (own) return own;
    }
    return this.#winner(0, 'TxDefaultProfile', at, tx, spec);
  }

  /** Power cap for the whole charge point from ChargePointMaxProfile, in W. */
  stationLimitW(at: Date, spec: ElectricalSpec): number | undefined {
    return this.#winner(0, 'ChargePointMaxProfile', at, undefined, spec)?.watts;
  }

  /** Power cap for one connector from Tx(Default)Profiles, in W. */
  connectorLimitW(
    connectorId: number,
    at: Date,
    tx: TransactionContext | undefined,
    spec: ElectricalSpec,
  ): number | undefined {
    return this.#transactionLimit(connectorId, at, tx, spec)?.watts;
  }

  /** Breakpoints where any profile may change its limit within `[from, to)`. */
  #breakpoints(from: Date, to: Date, tx: TransactionContext | undefined): number[] {
    const points = new Set<number>([from.getTime()]);
    const add = (time: number): void => {
      if (time > from.getTime() && time < to.getTime()) points.add(time);
    };
    for (const entry of this.#installed) {
      const { profile } = entry;
      if (profile.validFrom) add(new Date(profile.validFrom).getTime());
      if (profile.validTo) add(new Date(profile.validTo).getTime());
      const cycle =
        profile.chargingProfileKind === 'Recurring'
          ? profile.recurrencyKind === 'Weekly'
            ? 7 * DAY_MS
            : DAY_MS
          : undefined;
      const first = scheduleStart(entry, from, tx);
      if (!first) continue;
      const starts = [first.getTime()];
      if (cycle) for (let t = first.getTime() + cycle; t < to.getTime(); t += cycle) starts.push(t);
      for (const start of starts) {
        for (const period of profile.chargingSchedule.chargingSchedulePeriod) {
          add(start + period.startPeriod * 1_000);
        }
        if (profile.chargingSchedule.duration !== undefined) {
          add(start + profile.chargingSchedule.duration * 1_000);
        }
      }
    }
    return [...points].sort((a, b) => a - b);
  }

  /**
   * Handle GetCompositeSchedule: the effective limit over the next `durationS` seconds,
   * combining all applicable profiles and the hardware maximum.
   */
  compositeSchedule(
    connectorId: number,
    durationS: number,
    options: {
      readonly unit?: ChargingRateUnit | undefined;
      readonly now?: Date;
      readonly transaction?: TransactionContext | undefined;
      readonly hardwareMaxW: number;
      readonly spec: ElectricalSpec;
    },
  ): GetCompositeScheduleResponse {
    if (connectorId < 0 || connectorId > this.#options.connectors) return { status: 'Rejected' };
    const now = options.now ?? new Date();
    const unit = options.unit ?? 'W';
    const end = new Date(now.getTime() + durationS * 1_000);
    const tx = options.transaction;
    const periods: ChargingSchedulePeriod[] = [];
    for (const time of this.#breakpoints(now, end, tx)) {
      const at = new Date(time);
      const limit = minLimit(
        minLimit(
          this.#winner(0, 'ChargePointMaxProfile', at, undefined, options.spec),
          this.#transactionLimit(connectorId, at, tx, options.spec),
        ),
        { watts: options.hardwareMaxW, numberPhases: undefined },
      );
      const phases = limit?.numberPhases ?? options.spec.phases;
      const value =
        Math.round(
          fromWatts(limit?.watts ?? options.hardwareMaxW, unit, phases, options.spec) * 10,
        ) / 10;
      const previous = periods.at(-1);
      if (previous?.limit === value && previous.numberPhases === limit?.numberPhases) continue;
      periods.push({
        startPeriod: Math.round((time - now.getTime()) / 1_000),
        limit: value,
        ...(limit?.numberPhases === undefined ? {} : { numberPhases: limit.numberPhases }),
      });
    }
    return {
      status: 'Accepted',
      connectorId,
      scheduleStart: now.toISOString(),
      chargingSchedule: {
        duration: durationS,
        startSchedule: now.toISOString(),
        chargingRateUnit: unit,
        chargingSchedulePeriod: periods,
      },
    };
  }
}
