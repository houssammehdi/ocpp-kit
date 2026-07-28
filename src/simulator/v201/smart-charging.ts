/**
 * OCPP 2.0.1 smart charging of a simulated station (functional block K). Evaluation reuses the
 * version-neutral engine of the 1.6 simulator; what is specific to 2.0.1 is here: which profiles
 * SetChargingProfile accepts (use case K01), the `ChargingStationExternalConstraints` purpose, and
 * the reports of GetChargingProfiles.
 */
import type { v201 } from '../../messages/index.js';
import {
  compositePeriods,
  minLimit,
  profileBreakpoints,
  stackLimit,
  type ElectricalSpec,
  type PowerLimit,
  type StackedProfile,
} from '../smart-charging.js';

/** The transaction running on an EVSE, as the profile manager needs it. */
export interface TransactionContext201 {
  readonly transactionId: string;
  readonly startedAt: Date;
}

/** An installed profile with the EVSE it applies to and who set it. */
export interface InstalledProfile201 {
  readonly evseId: number;
  readonly profile: v201.ChargingProfile;
  /** `CSO` for profiles the CSMS installed, `EMS` for external constraints. */
  readonly source: v201.ChargingLimitSource;
}

interface Entry extends InstalledProfile201 {
  readonly stacked: StackedProfile;
}

/** Why a profile was refused, as a StatusInfo reason. */
export interface ProfileRejection {
  readonly status: 'Rejected';
  readonly statusInfo: v201.StatusInfo;
}

/** Options of {@link ChargingProfileManager201}. */
export interface ChargingProfileManager201Options {
  readonly evses: number;
  /** `SmartChargingCtrlr.ProfileStackLevel`: highest accepted stack level. Default: 8. */
  readonly maxStackLevel?: () => number;
  /** `SmartChargingCtrlr.PeriodsPerSchedule`. Default: 24. */
  readonly maxPeriods?: () => number;
  /** `SmartChargingCtrlr.Entries` maximum. Default: 16. */
  readonly maxProfiles?: number;
}

function stacked(profile: v201.ChargingProfile, receivedAt: Date): StackedProfile {
  const [schedule] = profile.chargingSchedule;
  if (!schedule) throw new RangeError(`Charging profile ${profile.id} has no schedule`);
  return {
    id: profile.id,
    stackLevel: profile.stackLevel,
    kind: profile.chargingProfileKind,
    recurrencyKind: profile.recurrencyKind,
    validFrom: profile.validFrom,
    validTo: profile.validTo,
    schedule,
    receivedAt,
  };
}

function overlaps(a: v201.ChargingProfile, b: v201.ChargingProfile): boolean {
  const start = (p: v201.ChargingProfile): number =>
    p.validFrom === undefined ? -Infinity : Date.parse(p.validFrom);
  const end = (p: v201.ChargingProfile): number =>
    p.validTo === undefined ? Infinity : Date.parse(p.validTo);
  return start(a) < end(b) && start(b) < end(a);
}

const reject = (reasonCode: string, additionalInfo: string): ProfileRejection => ({
  status: 'Rejected',
  statusInfo: { reasonCode, additionalInfo },
});

/**
 * Stores OCPP 2.0.1 charging profiles and evaluates them:
 *
 * - Within a purpose, the valid profile with the highest `stackLevel` wins (as in 1.6).
 * - A `TxProfile` overrides `TxDefaultProfile`s; an EVSE-specific `TxDefaultProfile` overrides one
 *   installed on EVSE 0.
 * - `ChargingStationMaxProfile` (EVSE 0) caps the station, and
 *   `ChargingStationExternalConstraints` (set locally, e.g. by an energy management system) caps
 *   the station (EVSE 0) or an EVSE: the effective limit is the lowest of them all.
 * - A profile with the id of an installed one replaces it. Unlike 1.6, a different profile with
 *   the same purpose and stack level on the same EVSE and an overlapping validity period is
 *   refused instead of replacing (K01.FR.06; for TxProfiles, the same stack level and
 *   transaction, K01.FR.39).
 */
export class ChargingProfileManager201 {
  readonly #evses: number;
  readonly #maxStackLevel: () => number;
  readonly #maxPeriods: () => number;
  readonly #maxProfiles: number;
  #entries: Entry[] = [];

  constructor(options: ChargingProfileManager201Options) {
    this.#evses = options.evses;
    this.#maxStackLevel = options.maxStackLevel ?? (() => 8);
    this.#maxPeriods = options.maxPeriods ?? (() => 24);
    this.#maxProfiles = options.maxProfiles ?? 16;
  }

  /** Installed profiles, optionally of one EVSE. */
  profiles(evseId?: number): InstalledProfile201[] {
    return this.#entries
      .filter((entry) => evseId === undefined || entry.evseId === evseId)
      .map(({ evseId: id, profile, source }) => ({ evseId: id, profile, source }));
  }

  /** Number of installed profiles (`SmartChargingCtrlr.Entries`). */
  get size(): number {
    return this.#entries.length;
  }

  /**
   * Handle SetChargingProfileRequest.
   *
   * @param transaction - the transaction running on `evseId`, if any
   */
  set(
    evseId: number,
    profile: v201.ChargingProfile,
    transaction: TransactionContext201 | undefined,
    now = new Date(),
  ): v201.SetChargingProfileResponse {
    const problem = this.#check(evseId, profile, transaction);
    if (problem) return problem;
    return this.#install({ evseId, profile, source: 'CSO' }, now);
  }

  /**
   * Install a `ChargingStationExternalConstraints` profile, as an energy management system
   * connected to the station would (not through SetChargingProfile, which refuses them).
   */
  setExternal(
    evseId: number,
    profile: v201.ChargingProfile,
    now = new Date(),
  ): v201.SetChargingProfileResponse {
    if (profile.chargingProfilePurpose !== 'ChargingStationExternalConstraints') {
      return reject('InvalidValue', 'external limits use ChargingStationExternalConstraints');
    }
    if (evseId < 0 || evseId > this.#evses) return reject('UnknownEvse', `no EVSE ${evseId}`);
    return this.#install({ evseId, profile, source: 'EMS' }, now);
  }

  /** Remove external constraints set with {@link setExternal}; returns whether any was removed. */
  clearExternal(evseId?: number): boolean {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter(
      (entry) => !(entry.source === 'EMS' && (evseId === undefined || entry.evseId === evseId)),
    );
    return this.#entries.length < before;
  }

  /** Handle ClearChargingProfileRequest. External constraints are never cleared (K10.FR.06). */
  clear(request: v201.ClearChargingProfileRequest): v201.ClearChargingProfileResponse {
    const criteria = request.chargingProfileCriteria;
    const matches = (entry: Entry): boolean => {
      if (entry.source !== 'CSO') return false;
      if (request.chargingProfileId !== undefined)
        return entry.profile.id === request.chargingProfileId;
      if (criteria?.evseId !== undefined && entry.evseId !== criteria.evseId) return false;
      if (
        criteria?.chargingProfilePurpose !== undefined &&
        entry.profile.chargingProfilePurpose !== criteria.chargingProfilePurpose
      ) {
        return false;
      }
      if (criteria?.stackLevel !== undefined && entry.profile.stackLevel !== criteria.stackLevel) {
        return false;
      }
      return true;
    };
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((entry) => !matches(entry));
    return { status: this.#entries.length < before ? 'Accepted' : 'Unknown' };
  }

  /** TxProfiles live as long as their transaction. */
  transactionEnded(evseId: number): void {
    this.#entries = this.#entries.filter(
      (entry) => !(entry.evseId === evseId && entry.profile.chargingProfilePurpose === 'TxProfile'),
    );
  }

  /**
   * The profiles GetChargingProfilesRequest selects, grouped the way ReportChargingProfiles
   * sends them: one group per EVSE and limit source.
   */
  select(request: v201.GetChargingProfilesRequest): InstalledProfile201[][] {
    const criterion = request.chargingProfile;
    const selected = this.#entries.filter((entry) => {
      if (request.evseId !== undefined && entry.evseId !== request.evseId) return false;
      const { profile } = entry;
      if (
        criterion.chargingProfilePurpose !== undefined &&
        profile.chargingProfilePurpose !== criterion.chargingProfilePurpose
      ) {
        return false;
      }
      if (criterion.stackLevel !== undefined && profile.stackLevel !== criterion.stackLevel)
        return false;
      if (criterion.chargingProfileId && !criterion.chargingProfileId.includes(profile.id))
        return false;
      if (criterion.chargingLimitSource && !criterion.chargingLimitSource.includes(entry.source)) {
        return false;
      }
      return true;
    });
    const groups = new Map<string, InstalledProfile201[]>();
    for (const { evseId, profile, source } of selected) {
      const key = `${evseId}/${source}`;
      const group = groups.get(key) ?? [];
      group.push({ evseId, profile, source });
      groups.set(key, group);
    }
    return [...groups.values()];
  }

  /** Station-wide cap (ChargingStationMaxProfile and external constraints on EVSE 0), in W. */
  stationLimitW(at: Date, spec: ElectricalSpec): number | undefined {
    return this.#stationLimit(at, spec)?.watts;
  }

  /** Cap of one EVSE from its Tx(Default)Profiles and external constraints, in W. */
  evseLimitW(
    evseId: number,
    at: Date,
    transaction: TransactionContext201 | undefined,
    spec: ElectricalSpec,
  ): number | undefined {
    return this.#evseLimit(evseId, at, transaction, spec)?.watts;
  }

  /** Handle GetCompositeScheduleRequest. */
  compositeSchedule(
    request: v201.GetCompositeScheduleRequest,
    options: {
      readonly now?: Date;
      readonly transaction?: TransactionContext201 | undefined;
      readonly hardwareMaxW: number;
      readonly spec: ElectricalSpec;
    },
  ): v201.GetCompositeScheduleResponse {
    const { evseId, duration } = request;
    if (evseId < 0 || evseId > this.#evses) {
      return { status: 'Rejected', statusInfo: { reasonCode: 'UnknownEvse' } };
    }
    const now = options.now ?? new Date();
    const unit = request.chargingRateUnit ?? 'W';
    const end = new Date(now.getTime() + duration * 1_000);
    const tx = options.transaction;
    const breakpoints = profileBreakpoints(
      this.#entries.map((entry) => entry.stacked),
      now,
      end,
      tx?.startedAt,
    );
    const periods = compositePeriods(
      breakpoints,
      now,
      (at) =>
        evseId === 0
          ? this.#stationLimit(at, options.spec)
          : minLimit(
              this.#stationLimit(at, options.spec),
              this.#evseLimit(evseId, at, tx, options.spec),
            ),
      { unit, hardwareMaxW: options.hardwareMaxW, spec: options.spec },
    );
    return {
      status: 'Accepted',
      schedule: {
        evseId,
        duration,
        scheduleStart: now.toISOString(),
        chargingRateUnit: unit,
        chargingSchedulePeriod: periods,
      },
    };
  }

  #check(
    evseId: number,
    profile: v201.ChargingProfile,
    transaction: TransactionContext201 | undefined,
  ): ProfileRejection | undefined {
    const purpose = profile.chargingProfilePurpose;
    if (evseId < 0 || evseId > this.#evses) return reject('UnknownEvse', `no EVSE ${evseId}`);
    if (purpose === 'ChargingStationExternalConstraints') {
      return reject('InvalidValue', 'ChargingStationExternalConstraints cannot be set (K01.FR.22)');
    }
    if (purpose === 'ChargingStationMaxProfile') {
      if (evseId !== 0) return reject('InvalidValue', 'ChargingStationMaxProfile needs evseId 0');
      if (profile.chargingProfileKind === 'Relative') {
        return reject('InvalidValue', 'a ChargingStationMaxProfile cannot be Relative (K01.FR.38)');
      }
    }
    if (purpose === 'TxProfile') {
      if (evseId === 0) return reject('InvalidValue', 'a TxProfile needs an EVSE (K01.FR.16)');
      if (profile.transactionId === undefined) {
        return reject('InvalidValue', 'a TxProfile needs a transactionId (K01.FR.03)');
      }
      if (transaction?.transactionId !== profile.transactionId) {
        return reject('TxNotFound', `no transaction ${profile.transactionId} on EVSE ${evseId}`);
      }
    }
    if (profile.stackLevel < 0 || profile.stackLevel > this.#maxStackLevel()) {
      return reject('InvalidStackLevel', `stackLevel above ${this.#maxStackLevel()}`);
    }
    if (profile.chargingProfileKind === 'Recurring') {
      if (!profile.recurrencyKind || profile.chargingSchedule.some((s) => !s.startSchedule)) {
        return reject(
          'InvalidSchedule',
          'a Recurring profile needs recurrencyKind and startSchedule',
        );
      }
    }
    for (const schedule of profile.chargingSchedule) {
      const periods = schedule.chargingSchedulePeriod;
      if (periods.length > this.#maxPeriods()) {
        return reject('InvalidSchedule', `more than ${this.#maxPeriods()} periods`);
      }
      if (periods[0]?.startPeriod !== 0) {
        return reject('InvalidSchedule', 'the first period must start at 0');
      }
      for (let i = 1; i < periods.length; i++) {
        if ((periods[i]?.startPeriod ?? 0) <= (periods[i - 1]?.startPeriod ?? 0)) {
          return reject('InvalidSchedule', 'startPeriods must increase');
        }
      }
      if (periods.some((p) => p.limit < 0)) return reject('InvalidSchedule', 'negative limit');
      if (periods.some((p) => p.phaseToUse !== undefined && p.numberPhases !== 1)) {
        return reject('InvalidSchedule', 'phaseToUse needs numberPhases 1');
      }
    }
    const conflict = this.#entries.find((entry) => {
      const other = entry.profile;
      if (other.id === profile.id || entry.source !== 'CSO') return false;
      if (other.chargingProfilePurpose !== purpose || other.stackLevel !== profile.stackLevel)
        return false;
      if (purpose === 'TxProfile') return other.transactionId === profile.transactionId;
      return entry.evseId === evseId && overlaps(other, profile);
    });
    if (conflict) {
      return reject(
        'DuplicateProfile',
        `profile ${conflict.profile.id} has the same purpose and stack level`,
      );
    }
    return undefined;
  }

  #install(profile: InstalledProfile201, now: Date): v201.SetChargingProfileResponse {
    const remaining = this.#entries.filter(
      (entry) => !(entry.profile.id === profile.profile.id && entry.source === profile.source),
    );
    if (remaining.length >= this.#maxProfiles) {
      return reject('NoSpace', `at most ${this.#maxProfiles} profiles`);
    }
    this.#entries = [...remaining, { ...profile, stacked: stacked(profile.profile, now) }];
    return { status: 'Accepted' };
  }

  #purpose(
    evseId: number,
    purpose: v201.ChargingProfilePurpose,
    at: Date,
    startedAt: Date | undefined,
    spec: ElectricalSpec,
  ): PowerLimit | undefined {
    const candidates = this.#entries
      .filter((e) => e.evseId === evseId && e.profile.chargingProfilePurpose === purpose)
      .map((e) => e.stacked);
    return stackLimit(candidates, at, startedAt, spec);
  }

  #stationLimit(at: Date, spec: ElectricalSpec): PowerLimit | undefined {
    return minLimit(
      this.#purpose(0, 'ChargingStationMaxProfile', at, undefined, spec),
      this.#purpose(0, 'ChargingStationExternalConstraints', at, undefined, spec),
    );
  }

  #evseLimit(
    evseId: number,
    at: Date,
    tx: TransactionContext201 | undefined,
    spec: ElectricalSpec,
  ): PowerLimit | undefined {
    const startedAt = tx?.startedAt;
    const txLimit =
      (tx ? this.#purpose(evseId, 'TxProfile', at, startedAt, spec) : undefined) ??
      this.#purpose(evseId, 'TxDefaultProfile', at, startedAt, spec) ??
      this.#purpose(0, 'TxDefaultProfile', at, startedAt, spec);
    return minLimit(
      txLimit,
      this.#purpose(evseId, 'ChargingStationExternalConstraints', at, startedAt, spec),
    );
  }
}
