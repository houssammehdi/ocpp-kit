/**
 * Data types shared by several OCPP 1.6 PDUs (chapter 7 of the specification), written by hand
 * from the specification text.
 */
import { Type, type Static } from '@sinclair/typebox';
import {
  CiString,
  DateTime,
  NonNegativeInteger,
  PositiveInteger,
  StringEnum,
  strict,
} from './primitives.js';

/** Identifier used for authorization (`IdToken`, a CiString20), e.g. an RFID card UID. */
export const IdToken = CiString(20);
/** Identifier used for authorization. Compare values with `ciEquals`. */
export type IdToken = Static<typeof IdToken>;

/** Outcome of an authorization. */
export const AuthorizationStatus = StringEnum([
  'Accepted',
  'Blocked',
  'Expired',
  'Invalid',
  'ConcurrentTx',
]);
/** Outcome of an authorization. */
export type AuthorizationStatus = Static<typeof AuthorizationStatus>;

/** Authorization result for an idTag, optionally with an expiry date and a parent (group) tag. */
export const IdTagInfo = Type.Object(
  {
    expiryDate: Type.Optional(DateTime()),
    parentIdTag: Type.Optional(IdToken),
    status: AuthorizationStatus,
  },
  strict,
);
/** Authorization result for an idTag. */
export type IdTagInfo = Static<typeof IdTagInfo>;

/**
 * An entry of the Local Authorization List. In a Differential update an entry without
 * `idTagInfo` removes the idTag; a Full update requires `idTagInfo` on every entry.
 */
export const AuthorizationData = Type.Object(
  { idTag: IdToken, idTagInfo: Type.Optional(IdTagInfo) },
  strict,
);
/** An entry of the Local Authorization List. */
export type AuthorizationData = Static<typeof AuthorizationData>;

/** Status of a connector (or, for connector 0, of the charge point as a whole). */
export const ChargePointStatus = StringEnum([
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
]);
/** Status of a connector or of the charge point. */
export type ChargePointStatus = Static<typeof ChargePointStatus>;

/** Error condition reported in StatusNotification. */
export const ChargePointErrorCode = StringEnum([
  'ConnectorLockFailure',
  'EVCommunicationError',
  'GroundFailure',
  'HighTemperature',
  'InternalError',
  'LocalListConflict',
  'NoError',
  'OtherError',
  'OverCurrentFailure',
  'PowerMeterFailure',
  'PowerSwitchFailure',
  'ReaderFailure',
  'ResetFailure',
  'UnderVoltage',
  'OverVoltage',
  'WeakSignal',
]);
/** Error condition reported in StatusNotification. */
export type ChargePointErrorCode = Static<typeof ChargePointErrorCode>;

/** Why a sampled value was taken (default `Sample.Periodic`). */
export const ReadingContext = StringEnum([
  'Interruption.Begin',
  'Interruption.End',
  'Other',
  'Sample.Clock',
  'Sample.Periodic',
  'Transaction.Begin',
  'Transaction.End',
  'Trigger',
]);
/** Why a sampled value was taken. */
export type ReadingContext = Static<typeof ReadingContext>;

/** Whether a sampled value is plain (`Raw`, the default) or signed data. */
export const ValueFormat = StringEnum(['Raw', 'SignedData']);
/** Format of a sampled value. */
export type ValueFormat = Static<typeof ValueFormat>;

/** What a sampled value measures (default `Energy.Active.Import.Register`). */
export const Measurand = StringEnum([
  'Current.Export',
  'Current.Import',
  'Current.Offered',
  'Energy.Active.Export.Register',
  'Energy.Active.Import.Register',
  'Energy.Reactive.Export.Register',
  'Energy.Reactive.Import.Register',
  'Energy.Active.Export.Interval',
  'Energy.Active.Import.Interval',
  'Energy.Reactive.Export.Interval',
  'Energy.Reactive.Import.Interval',
  'Frequency',
  'Power.Active.Export',
  'Power.Active.Import',
  'Power.Factor',
  'Power.Offered',
  'Power.Reactive.Export',
  'Power.Reactive.Import',
  'RPM',
  'SoC',
  'Temperature',
  'Voltage',
]);
/** What a sampled value measures. */
export type Measurand = Static<typeof Measurand>;

/** Phase a value refers to. Without a phase a value is an overall value. */
export const Phase = StringEnum([
  'L1',
  'L2',
  'L3',
  'N',
  'L1-N',
  'L2-N',
  'L3-N',
  'L1-L2',
  'L2-L3',
  'L3-L1',
]);
/** Phase a value refers to. */
export type Phase = Static<typeof Phase>;

/** Where a value was measured (default `Outlet`). */
export const Location = StringEnum(['Body', 'Cable', 'EV', 'Inlet', 'Outlet']);
/** Where a value was measured. */
export type Location = Static<typeof Location>;

/**
 * Units of measure. Energy values default to `Wh`. Both `Celcius` (the spelling of the official
 * JSON schema) and `Celsius` (the spelling of the specification text) are accepted. `Hertz` is
 * not in the specification's list, but some copies of the official MeterValues schema include it
 * for the `Frequency` measurand, so it is accepted as well.
 */
export const UnitOfMeasure = StringEnum([
  'Wh',
  'kWh',
  'varh',
  'kvarh',
  'W',
  'kW',
  'VA',
  'kVA',
  'var',
  'kvar',
  'A',
  'V',
  'K',
  'Celcius',
  'Celsius',
  'Fahrenheit',
  'Percent',
  'Hertz',
]);
/** Unit of a sampled value. */
export type UnitOfMeasure = Static<typeof UnitOfMeasure>;

/** A single measured value. `value` is always transmitted as a string. */
export const SampledValue = Type.Object(
  {
    value: Type.String(),
    context: Type.Optional(ReadingContext),
    format: Type.Optional(ValueFormat),
    measurand: Type.Optional(Measurand),
    phase: Type.Optional(Phase),
    location: Type.Optional(Location),
    unit: Type.Optional(UnitOfMeasure),
  },
  strict,
);
/** A single measured value. */
export type SampledValue = Static<typeof SampledValue>;

/** A set of sampled values taken at the same point in time. */
export const MeterValue = Type.Object(
  {
    timestamp: DateTime(),
    sampledValue: Type.Array(SampledValue, { minItems: 1 }),
  },
  strict,
);
/** A set of sampled values taken at the same point in time. */
export type MeterValue = Static<typeof MeterValue>;

/** Why a transaction ended (default `Local`). */
export const StopReason = StringEnum([
  'EmergencyStop',
  'EVDisconnected',
  'HardReset',
  'Local',
  'Other',
  'PowerLoss',
  'Reboot',
  'Remote',
  'SoftReset',
  'UnlockCommand',
  'DeAuthorized',
]);
/** Why a transaction ended. */
export type StopReason = Static<typeof StopReason>;

/** What a charging profile is used for. */
export const ChargingProfilePurpose = StringEnum([
  'ChargePointMaxProfile',
  'TxDefaultProfile',
  'TxProfile',
]);
/** What a charging profile is used for. */
export type ChargingProfilePurpose = Static<typeof ChargingProfilePurpose>;

/** How the schedule periods of a profile are anchored in time. */
export const ChargingProfileKind = StringEnum(['Absolute', 'Recurring', 'Relative']);
/** How the schedule periods of a profile are anchored in time. */
export type ChargingProfileKind = Static<typeof ChargingProfileKind>;

/** Recurrence of a `Recurring` profile. */
export const RecurrencyKind = StringEnum(['Daily', 'Weekly']);
/** Recurrence of a `Recurring` profile. */
export type RecurrencyKind = Static<typeof RecurrencyKind>;

/** Unit of charging schedule limits: amperes per phase or watts. */
export const ChargingRateUnit = StringEnum(['A', 'W']);
/** Unit of charging schedule limits. */
export type ChargingRateUnit = Static<typeof ChargingRateUnit>;

/** One step of a charging schedule, starting `startPeriod` seconds after the schedule start. */
export const ChargingSchedulePeriod = Type.Object(
  {
    startPeriod: NonNegativeInteger('Seconds from the start of the schedule'),
    limit: Type.Number({ minimum: 0, description: 'Limit in the schedule charging rate unit' }),
    numberPhases: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
  },
  strict,
);
/** One step of a charging schedule. */
export type ChargingSchedulePeriod = Static<typeof ChargingSchedulePeriod>;

/** A charging schedule: a list of periods with limits, optionally anchored and bounded. */
export const ChargingSchedule = Type.Object(
  {
    duration: Type.Optional(NonNegativeInteger('Duration of the schedule in seconds')),
    startSchedule: Type.Optional(DateTime()),
    chargingRateUnit: ChargingRateUnit,
    chargingSchedulePeriod: Type.Array(ChargingSchedulePeriod, { minItems: 1 }),
    minChargingRate: Type.Optional(Type.Number({ minimum: 0 })),
  },
  strict,
);
/** A charging schedule. */
export type ChargingSchedule = Static<typeof ChargingSchedule>;

/** A charging profile as sent in SetChargingProfile and RemoteStartTransaction. */
export const ChargingProfile = Type.Object(
  {
    chargingProfileId: Type.Integer(),
    transactionId: Type.Optional(Type.Integer()),
    stackLevel: NonNegativeInteger(),
    chargingProfilePurpose: ChargingProfilePurpose,
    chargingProfileKind: ChargingProfileKind,
    recurrencyKind: Type.Optional(RecurrencyKind),
    validFrom: Type.Optional(DateTime()),
    validTo: Type.Optional(DateTime()),
    chargingSchedule: ChargingSchedule,
  },
  strict,
);
/** A charging profile. */
export type ChargingProfile = Static<typeof ChargingProfile>;

/** A configuration key as returned by GetConfiguration. */
export const KeyValue = Type.Object(
  {
    key: CiString(50),
    readonly: Type.Boolean(),
    value: Type.Optional(CiString(500)),
  },
  strict,
);
/** A configuration key as returned by GetConfiguration. */
export type KeyValue = Static<typeof KeyValue>;

/** Connector id where 0 addresses the whole charge point. */
export const ConnectorIdOrStation = NonNegativeInteger('0 = charge point as a whole');

/** Connector id of a physical connector (numbering starts at 1). */
export const ConnectorId = PositiveInteger('Connector id, starting at 1');
