import { Type, type Static } from '@sinclair/typebox';
import {
  CiString,
  DateTime,
  NonNegativeInteger,
  PositiveInteger,
  StringEnum,
  strict,
} from './primitives.js';

/** Identifier used for authorization (`IdToken`, CiString20). */
export const IdToken = CiString(20);
export type IdToken = Static<typeof IdToken>;

export const AuthorizationStatus = StringEnum([
  'Accepted',
  'Blocked',
  'Expired',
  'Invalid',
  'ConcurrentTx',
]);
export type AuthorizationStatus = Static<typeof AuthorizationStatus>;

/** Authorization result for an idTag. */
export const IdTagInfo = Type.Object(
  {
    expiryDate: Type.Optional(DateTime()),
    parentIdTag: Type.Optional(IdToken),
    status: AuthorizationStatus,
  },
  strict,
);
export type IdTagInfo = Static<typeof IdTagInfo>;

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
export type ChargePointStatus = Static<typeof ChargePointStatus>;

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
export type ChargePointErrorCode = Static<typeof ChargePointErrorCode>;

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
export type ReadingContext = Static<typeof ReadingContext>;

export const ValueFormat = StringEnum(['Raw', 'SignedData']);
export type ValueFormat = Static<typeof ValueFormat>;

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
export type Measurand = Static<typeof Measurand>;

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
export type Phase = Static<typeof Phase>;

export const Location = StringEnum(['Body', 'Cable', 'EV', 'Inlet', 'Outlet']);
export type Location = Static<typeof Location>;

/** Units of measure. Both `Celcius` (specification spelling) and `Celsius` are accepted. */
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
]);
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
export type SampledValue = Static<typeof SampledValue>;

/** A set of sampled values taken at the same point in time. */
export const MeterValue = Type.Object(
  {
    timestamp: DateTime(),
    sampledValue: Type.Array(SampledValue, { minItems: 1 }),
  },
  strict,
);
export type MeterValue = Static<typeof MeterValue>;

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
export type StopReason = Static<typeof StopReason>;

export const ChargingProfilePurpose = StringEnum([
  'ChargePointMaxProfile',
  'TxDefaultProfile',
  'TxProfile',
]);
export type ChargingProfilePurpose = Static<typeof ChargingProfilePurpose>;

export const ChargingProfileKind = StringEnum(['Absolute', 'Recurring', 'Relative']);
export type ChargingProfileKind = Static<typeof ChargingProfileKind>;

export const RecurrencyKind = StringEnum(['Daily', 'Weekly']);
export type RecurrencyKind = Static<typeof RecurrencyKind>;

export const ChargingRateUnit = StringEnum(['A', 'W']);
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
export type ChargingSchedulePeriod = Static<typeof ChargingSchedulePeriod>;

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
export type ChargingSchedule = Static<typeof ChargingSchedule>;

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
export type KeyValue = Static<typeof KeyValue>;

/** Connector id where 0 addresses the whole charge point. */
export const ConnectorIdOrStation = NonNegativeInteger('0 = charge point as a whole');

/** Connector id of a physical connector (numbering starts at 1). */
export const ConnectorId = PositiveInteger('Connector id, starting at 1');
