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

// ---------------------------------------------------------------------------------------------
// The version-neutral engine
// ---------------------------------------------------------------------------------------------

/** One step of a schedule: a limit from `startPeriod` seconds after the schedule start. */
export interface SchedulePeriod {
  readonly startPeriod: number;
  readonly limit: number;
  readonly numberPhases?: number | undefined;
}

/** A charging schedule as the engine evaluates it (the same shape in OCPP 1.6 and 2.0.1). */
export interface ScheduleShape {
  readonly startSchedule?: string | undefined;
  readonly duration?: number | undefined;
  readonly chargingRateUnit: ChargingRateUnit;
  readonly chargingSchedulePeriod: readonly SchedulePeriod[];
}

/**
 * A charging profile in the version-neutral form the engine evaluates. OCPP 1.6 and 2.0.1 anchor
 * schedules in time the same way (Absolute, Relative, Daily/Weekly Recurring) and choose between
 * profiles of one purpose the same way (highest valid stack level); what differs between the
 * versions is which profiles a charge point accepts and how purposes combine, which the
 * version-specific managers decide.
 */
export interface StackedProfile {
  readonly id: number;
  readonly stackLevel: number;
  readonly kind: 'Absolute' | 'Recurring' | 'Relative';
  readonly recurrencyKind?: 'Daily' | 'Weekly' | undefined;
  readonly validFrom?: string | undefined;
  readonly validTo?: string | undefined;
  readonly schedule: ScheduleShape;
  /**
   * When the profile was installed: the schedule start of an Absolute profile without
   * startSchedule that is evaluated outside a transaction (e.g. a station-wide maximum).
   */
  readonly receivedAt: Date;
}

/** A limit evaluated at an instant, always expressed in watts. */
export interface PowerLimit {
  readonly watts: number;
  readonly numberPhases: number | undefined;
}

const DAY_MS = 86_400_000;

/** Convert a schedule limit to watts. */
export function toWatts(
  limit: number,
  unit: ChargingRateUnit,
  phases: number,
  spec: ElectricalSpec,
): number {
  return unit === 'W' ? limit : limit * spec.voltage * phases;
}

/** Convert watts to a schedule limit in `unit`. */
export function fromWatts(
  watts: number,
  unit: ChargingRateUnit,
  phases: number,
  spec: ElectricalSpec,
): number {
  return unit === 'W' ? watts : watts / (spec.voltage * phases);
}

/**
 * Start instant of the schedule instance that is (or was last) active at `at`.
 *
 * @param startedAt - start of the transaction the profile is evaluated for, if any
 */
export function scheduleStart(
  profile: StackedProfile,
  at: Date,
  startedAt: Date | undefined,
): Date | undefined {
  const { startSchedule } = profile.schedule;
  switch (profile.kind) {
    case 'Absolute':
      // OCPP 1.6 ChargingSchedule.startSchedule: "If absent the schedule will be relative to
      // start of charging." Without a transaction there is no such start, so fall back to the
      // moment the profile was installed.
      if (startSchedule) return new Date(startSchedule);
      return startedAt ?? profile.receivedAt;
    case 'Relative':
      return startedAt ?? at;
    case 'Recurring': {
      if (!startSchedule) return undefined;
      const period = profile.recurrencyKind === 'Weekly' ? 7 * DAY_MS : DAY_MS;
      const origin = new Date(startSchedule).getTime();
      const cycles = Math.floor((at.getTime() - origin) / period);
      return new Date(origin + cycles * period);
    }
  }
}

function isValidAt(profile: StackedProfile, at: Date): boolean {
  if (profile.validFrom && at < new Date(profile.validFrom)) return false;
  if (profile.validTo && at >= new Date(profile.validTo)) return false;
  return true;
}

/** Evaluate one profile at `at`; `undefined` when it does not constrain that instant. */
export function evaluateProfile(
  profile: StackedProfile,
  at: Date,
  startedAt: Date | undefined,
  spec: ElectricalSpec,
): PowerLimit | undefined {
  if (!isValidAt(profile, at)) return undefined;
  const start = scheduleStart(profile, at, startedAt);
  if (!start) return undefined;
  const elapsedS = (at.getTime() - start.getTime()) / 1_000;
  const { schedule } = profile;
  if (elapsedS < 0) return undefined;
  if (schedule.duration !== undefined && elapsedS >= schedule.duration) return undefined;
  let active: SchedulePeriod | undefined;
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

/**
 * The limit of the valid profile with the highest stack level among `candidates` (the profiles
 * of one purpose), or `undefined` when none constrains `at`.
 */
export function stackLimit(
  candidates: readonly StackedProfile[],
  at: Date,
  startedAt: Date | undefined,
  spec: ElectricalSpec,
): PowerLimit | undefined {
  const sorted = [...candidates].sort((a, b) => b.stackLevel - a.stackLevel);
  for (const profile of sorted) {
    const limit = evaluateProfile(profile, at, startedAt, spec);
    if (limit) return limit;
  }
  return undefined;
}

/** The lower of two limits (either may be absent). */
export function minLimit(
  a: PowerLimit | undefined,
  b: PowerLimit | undefined,
): PowerLimit | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.watts <= b.watts ? a : b;
}

/** Instants within `[from, to)` where any of `profiles` may change its limit, sorted. */
export function profileBreakpoints(
  profiles: readonly StackedProfile[],
  from: Date,
  to: Date,
  startedAt: Date | undefined,
): number[] {
  const points = new Set<number>([from.getTime()]);
  const add = (time: number): void => {
    if (time > from.getTime() && time < to.getTime()) points.add(time);
  };
  for (const profile of profiles) {
    if (profile.validFrom) add(new Date(profile.validFrom).getTime());
    if (profile.validTo) add(new Date(profile.validTo).getTime());
    const cycle =
      profile.kind === 'Recurring'
        ? profile.recurrencyKind === 'Weekly'
          ? 7 * DAY_MS
          : DAY_MS
        : undefined;
    const first = scheduleStart(profile, from, startedAt);
    if (!first) continue;
    const starts = [first.getTime()];
    if (cycle) for (let t = first.getTime() + cycle; t < to.getTime(); t += cycle) starts.push(t);
    for (const start of starts) {
      for (const period of profile.schedule.chargingSchedulePeriod) {
        add(start + period.startPeriod * 1_000);
      }
      if (profile.schedule.duration !== undefined) add(start + profile.schedule.duration * 1_000);
    }
  }
  return [...points].sort((a, b) => a - b);
}

/**
 * The periods of a composite schedule from `now`: the effective limit (`limitAt`, capped by the
 * hardware maximum) at every breakpoint, in `unit`, with consecutive equal limits merged.
 */
export function compositePeriods(
  breakpoints: readonly number[],
  now: Date,
  limitAt: (at: Date) => PowerLimit | undefined,
  options: {
    readonly unit: ChargingRateUnit;
    readonly hardwareMaxW: number;
    readonly spec: ElectricalSpec;
  },
): ChargingSchedulePeriod[] {
  const { unit, hardwareMaxW, spec } = options;
  const periods: ChargingSchedulePeriod[] = [];
  for (const time of breakpoints) {
    const limit = minLimit(limitAt(new Date(time)), {
      watts: hardwareMaxW,
      numberPhases: undefined,
    });
    const phases = limit?.numberPhases ?? spec.phases;
    const value = Math.round(fromWatts(limit?.watts ?? hardwareMaxW, unit, phases, spec) * 10) / 10;
    const startPeriod = Math.round((time - now.getTime()) / 1_000);
    // Breakpoints less than a second apart round to the same startPeriod; startPeriods must
    // increase, so the later limit (the one that holds from then on) takes the slot.
    if (periods.at(-1)?.startPeriod === startPeriod) periods.pop();
    const previous = periods.at(-1);
    if (previous?.limit === value && previous.numberPhases === limit?.numberPhases) continue;
    periods.push({
      startPeriod,
      limit: value,
      ...(limit?.numberPhases === undefined ? {} : { numberPhases: limit.numberPhases }),
    });
  }
  return periods;
}

// ---------------------------------------------------------------------------------------------
// OCPP 1.6
// ---------------------------------------------------------------------------------------------

interface Installed {
  readonly connectorId: number;
  readonly profile: ChargingProfile;
  readonly stacked: StackedProfile;
}

/** The engine's view of an OCPP 1.6 profile. */
function stacked(profile: ChargingProfile, receivedAt: Date): StackedProfile {
  return {
    id: profile.chargingProfileId,
    stackLevel: profile.stackLevel,
    kind: profile.chargingProfileKind,
    recurrencyKind: profile.recurrencyKind,
    validFrom: profile.validFrom,
    validTo: profile.validTo,
    schedule: profile.chargingSchedule,
    receivedAt,
  };
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
 * Stores OCPP 1.6 charging profiles and evaluates them following the 1.6 stacking rules:
 *
 * - Within a purpose, the valid profile with the highest `stackLevel` wins.
 * - A `TxProfile` overrides `TxDefaultProfile`s; a connector-specific `TxDefaultProfile`
 *   overrides one installed on connector 0.
 * - `ChargePointMaxProfile` (connector 0 only) caps the charge point as a whole.
 * - A new profile replaces one with the same id, or with the same purpose and stack level on the
 *   same connector.
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
    this.#installed = [
      ...remaining,
      { connectorId, profile: stored, stacked: stacked(stored, now) },
    ];
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
  ): PowerLimit | undefined {
    const candidates = this.#installed
      .filter((e) => e.connectorId === connectorId && e.profile.chargingProfilePurpose === purpose)
      .map((e) => e.stacked);
    return stackLimit(candidates, at, tx?.startedAt, spec);
  }

  #transactionLimit(
    connectorId: number,
    at: Date,
    tx: TransactionContext | undefined,
    spec: ElectricalSpec,
  ): PowerLimit | undefined {
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
    const breakpoints = profileBreakpoints(
      this.#installed.map((entry) => entry.stacked),
      now,
      end,
      tx?.startedAt,
    );
    const periods = compositePeriods(
      breakpoints,
      now,
      (at) =>
        minLimit(
          this.#winner(0, 'ChargePointMaxProfile', at, undefined, options.spec),
          this.#transactionLimit(connectorId, at, tx, options.spec),
        ),
      { unit, hardwareMaxW: options.hardwareMaxW, spec: options.spec },
    );
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
