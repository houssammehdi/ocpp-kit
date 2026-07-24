/**
 * Data types and enumerations shared by several OCPP 2.0.1 messages, written by hand from the
 * OCPP 2.0.1 specification (Part 2, "Datatypes" and "Enumerations").
 */
import { Type, type Static } from '@sinclair/typebox';
import { DateTime, Obj, Str, StringEnum } from './primitives.js';

// ---------------------------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------------------------

/** `StatusInfoType`: why a request got the status it got. */
export const StatusInfo = Obj({
  reasonCode: Str(20, 'A predefined code for the reason why the status is returned'),
  additionalInfo: Type.Optional(Str(512)),
});
/** Details of a status. */
export type StatusInfo = Static<typeof StatusInfo>;

/**
 * `EVSEType`: an EVSE (`id`, starting at 1) and optionally one of its connectors
 * (`connectorId`, starting at 1 within the EVSE).
 */
export const Evse = Obj({
  id: Type.Integer({ description: 'EVSE id; numbering starts at 1' }),
  connectorId: Type.Optional(Type.Integer({ description: 'Connector id within the EVSE' })),
});
/** An EVSE, optionally narrowed to one connector. */
export type Evse = Static<typeof Evse>;

/** `MessageFormatEnumType`. */
export const MessageFormat = StringEnum(['ASCII', 'HTML', 'URI', 'UTF8']);
/** Format of a message shown to the driver. */
export type MessageFormat = Static<typeof MessageFormat>;

/** `MessageContentType`: a message for the driver. */
export const MessageContent = Obj({
  format: MessageFormat,
  language: Type.Optional(Str(8)),
  content: Str(512),
});
/** A message for the driver. */
export type MessageContent = Static<typeof MessageContent>;

/** `GenericStatusEnumType`. */
export const GenericStatus = StringEnum(['Accepted', 'Rejected']);
/** Accepted or Rejected. */
export type GenericStatus = Static<typeof GenericStatus>;

// ---------------------------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------------------------

/** `IdTokenEnumType`: how an idToken was presented or what it is. */
export const IdTokenKind = StringEnum([
  'Central',
  'eMAID',
  'ISO14443',
  'ISO15693',
  'KeyCode',
  'Local',
  'MacAddress',
  'NoAuthorization',
]);
/** Kind of an idToken. */
export type IdTokenKind = Static<typeof IdTokenKind>;

/** `AdditionalInfoType`: an extra identifier attached to an idToken. */
export const AdditionalInfo = Obj({
  additionalIdToken: Str(36),
  type: Str(50),
});
/** An extra identifier attached to an idToken. */
export type AdditionalInfo = Static<typeof AdditionalInfo>;

/**
 * `IdTokenType`: an identifier (case-insensitive, at most 36 characters) together with its kind.
 * Unlike the 1.6 idTag, a 2.0.1 idToken is only meaningful with its `type`.
 */
export const IdToken = Obj({
  idToken: Str(36),
  type: IdTokenKind,
  additionalInfo: Type.Optional(Type.Array(AdditionalInfo, { minItems: 1 })),
});
/** An identifier with its kind. */
export type IdToken = Static<typeof IdToken>;

/** `AuthorizationStatusEnumType`. */
export const AuthorizationStatus = StringEnum([
  'Accepted',
  'Blocked',
  'ConcurrentTx',
  'Expired',
  'Invalid',
  'NoCredit',
  'NotAllowedTypeEVSE',
  'NotAtThisLocation',
  'NotAtThisTime',
  'Unknown',
]);
/** Whether an idToken may charge. */
export type AuthorizationStatus = Static<typeof AuthorizationStatus>;

/** `IdTokenInfoType`: what the CSMS says about an idToken. */
export const IdTokenInfo = Obj({
  status: AuthorizationStatus,
  cacheExpiryDateTime: Type.Optional(DateTime()),
  chargingPriority: Type.Optional(Type.Integer()),
  language1: Type.Optional(Str(8)),
  evseId: Type.Optional(Type.Array(Type.Integer(), { minItems: 1 })),
  groupIdToken: Type.Optional(IdToken),
  language2: Type.Optional(Str(8)),
  personalMessage: Type.Optional(MessageContent),
});
/** Authorization information of an idToken. */
export type IdTokenInfo = Static<typeof IdTokenInfo>;

/** `HashAlgorithmEnumType`. */
export const HashAlgorithm = StringEnum(['SHA256', 'SHA384', 'SHA512']);
/** Hash algorithm of certificate hash data. */
export type HashAlgorithm = Static<typeof HashAlgorithm>;

/** `OCSPRequestDataType`: identifies a certificate for an OCSP check (ISO 15118). */
export const OcspRequestData = Obj({
  hashAlgorithm: HashAlgorithm,
  issuerNameHash: Str(128),
  issuerKeyHash: Str(128),
  serialNumber: Str(40),
  responderURL: Str(512),
});
/** Certificate identification for an OCSP check. */
export type OcspRequestData = Static<typeof OcspRequestData>;

// ---------------------------------------------------------------------------------------------
// Device model
// ---------------------------------------------------------------------------------------------

/** `ComponentType`: a component of the device model, optionally located at an EVSE. */
export const Component = Obj({
  name: Str(50),
  instance: Type.Optional(Str(50)),
  evse: Type.Optional(Evse),
});
/** A device model component. */
export type Component = Static<typeof Component>;

/** `VariableType`: a variable of a component. */
export const Variable = Obj({
  name: Str(50),
  instance: Type.Optional(Str(50)),
});
/** A device model variable. */
export type Variable = Static<typeof Variable>;

/** `AttributeEnumType`: which value of a variable. */
export const AttributeKind = StringEnum(['Actual', 'Target', 'MinSet', 'MaxSet']);
/** Which value of a variable. */
export type AttributeKind = Static<typeof AttributeKind>;

/** `MutabilityEnumType`. */
export const Mutability = StringEnum(['ReadOnly', 'WriteOnly', 'ReadWrite']);
/** Whether a variable attribute can be read and written. */
export type Mutability = Static<typeof Mutability>;

/** `DataEnumType`: data type of a variable. */
export const DataKind = StringEnum([
  'string',
  'decimal',
  'integer',
  'dateTime',
  'boolean',
  'OptionList',
  'SequenceList',
  'MemberList',
]);
/** Data type of a variable. */
export type DataKind = Static<typeof DataKind>;

/** `VariableAttributeType`: one attribute value as reported in NotifyReport. */
export const VariableAttribute = Obj({
  type: Type.Optional(AttributeKind),
  value: Type.Optional(Str(2500)),
  mutability: Type.Optional(Mutability),
  persistent: Type.Optional(Type.Boolean()),
  constant: Type.Optional(Type.Boolean()),
});
/** One attribute of a variable. */
export type VariableAttribute = Static<typeof VariableAttribute>;

/** `VariableCharacteristicsType`: fixed properties of a variable. */
export const VariableCharacteristics = Obj({
  unit: Type.Optional(Str(16)),
  dataType: DataKind,
  minLimit: Type.Optional(Type.Number()),
  maxLimit: Type.Optional(Type.Number()),
  valuesList: Type.Optional(Str(1000)),
  supportsMonitoring: Type.Boolean(),
});
/** Fixed properties of a variable. */
export type VariableCharacteristics = Static<typeof VariableCharacteristics>;

/** `ReportDataType`: one variable in a NotifyReport. */
export const ReportData = Obj({
  component: Component,
  variable: Variable,
  variableAttribute: Type.Array(VariableAttribute, { minItems: 1, maxItems: 4 }),
  variableCharacteristics: Type.Optional(VariableCharacteristics),
});
/** One variable in a NotifyReport. */
export type ReportData = Static<typeof ReportData>;

// ---------------------------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------------------------

/** `ReadingContextEnumType`. */
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
/** Why a value was sampled. */
export type ReadingContext = Static<typeof ReadingContext>;

/** `MeasurandEnumType`. */
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
  'Energy.Active.Net',
  'Energy.Reactive.Export.Interval',
  'Energy.Reactive.Import.Interval',
  'Energy.Reactive.Net',
  'Energy.Apparent.Net',
  'Energy.Apparent.Import',
  'Energy.Apparent.Export',
  'Frequency',
  'Power.Active.Export',
  'Power.Active.Import',
  'Power.Factor',
  'Power.Offered',
  'Power.Reactive.Export',
  'Power.Reactive.Import',
  'SoC',
  'Voltage',
]);
/** What is measured. */
export type Measurand = Static<typeof Measurand>;

/** `PhaseEnumType`. */
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
/** Phase (or phase pair) a value was measured on. */
export type Phase = Static<typeof Phase>;

/** `LocationEnumType`. */
export const Location = StringEnum(['Body', 'Cable', 'EV', 'Inlet', 'Outlet']);
/** Where a value was measured. */
export type Location = Static<typeof Location>;

/** `SignedMeterValueType`. */
export const SignedMeterValue = Obj({
  signedMeterData: Str(2500),
  signingMethod: Str(50),
  encodingMethod: Str(50),
  publicKey: Str(2500),
});
/** A signed meter reading. */
export type SignedMeterValue = Static<typeof SignedMeterValue>;

/**
 * `UnitOfMeasureType`: unit (default `Wh`) and a power-of-ten multiplier (default 0), e.g.
 * `{ unit: 'Wh', multiplier: 3 }` for kWh.
 */
export const UnitOfMeasure = Obj({
  unit: Type.Optional(Str(20)),
  multiplier: Type.Optional(Type.Integer()),
});
/** Unit of a sampled value. */
export type UnitOfMeasure = Static<typeof UnitOfMeasure>;

/** `SampledValueType`. Unlike 1.6, `value` is a number. */
export const SampledValue = Obj({
  value: Type.Number(),
  context: Type.Optional(ReadingContext),
  measurand: Type.Optional(Measurand),
  phase: Type.Optional(Phase),
  location: Type.Optional(Location),
  signedMeterValue: Type.Optional(SignedMeterValue),
  unitOfMeasure: Type.Optional(UnitOfMeasure),
});
/** One measured value. */
export type SampledValue = Static<typeof SampledValue>;

/** `MeterValueType`: values sampled at the same time. */
export const MeterValue = Obj({
  sampledValue: Type.Array(SampledValue, { minItems: 1 }),
  timestamp: DateTime(),
});
/** Values sampled at the same time. */
export type MeterValue = Static<typeof MeterValue>;

// ---------------------------------------------------------------------------------------------
// Smart charging
// ---------------------------------------------------------------------------------------------

/** `ChargingProfilePurposeEnumType`. */
export const ChargingProfilePurpose = StringEnum([
  'ChargingStationExternalConstraints',
  'ChargingStationMaxProfile',
  'TxDefaultProfile',
  'TxProfile',
]);
/** What a charging profile is for. */
export type ChargingProfilePurpose = Static<typeof ChargingProfilePurpose>;

/** `ChargingProfileKindEnumType`. */
export const ChargingProfileKind = StringEnum(['Absolute', 'Recurring', 'Relative']);
/** How the schedule of a profile is anchored in time. */
export type ChargingProfileKind = Static<typeof ChargingProfileKind>;

/** `RecurrencyKindEnumType`. */
export const RecurrencyKind = StringEnum(['Daily', 'Weekly']);
/** Recurrence of a Recurring profile. */
export type RecurrencyKind = Static<typeof RecurrencyKind>;

/** `ChargingRateUnitEnumType`. */
export const ChargingRateUnit = StringEnum(['W', 'A']);
/** Unit of schedule limits: watts, or amperes per phase. */
export type ChargingRateUnit = Static<typeof ChargingRateUnit>;

/** `ChargingSchedulePeriodType`. */
export const ChargingSchedulePeriod = Obj({
  startPeriod: Type.Integer({ description: 'Seconds from the start of the schedule' }),
  limit: Type.Number(),
  numberPhases: Type.Optional(Type.Integer()),
  phaseToUse: Type.Optional(Type.Integer()),
});
/** One step of a charging schedule. */
export type ChargingSchedulePeriod = Static<typeof ChargingSchedulePeriod>;

/** `CostKindEnumType`. */
export const CostKind = StringEnum([
  'CarbonDioxideEmission',
  'RelativePricePercentage',
  'RenewableGenerationPercentage',
]);
/** Kind of a cost indicator. */
export type CostKind = Static<typeof CostKind>;

/** `CostType`. */
export const Cost = Obj({
  costKind: CostKind,
  amount: Type.Integer(),
  amountMultiplier: Type.Optional(Type.Integer()),
});
/** A cost indicator. */
export type Cost = Static<typeof Cost>;

/** `ConsumptionCostType`. */
export const ConsumptionCost = Obj({
  startValue: Type.Number(),
  cost: Type.Array(Cost, { minItems: 1, maxItems: 3 }),
});
/** Cost from a consumption threshold on. */
export type ConsumptionCost = Static<typeof ConsumptionCost>;

/** `RelativeTimeIntervalType`. */
export const RelativeTimeInterval = Obj({
  start: Type.Integer(),
  duration: Type.Optional(Type.Integer()),
});
/** A time interval relative to the schedule start. */
export type RelativeTimeInterval = Static<typeof RelativeTimeInterval>;

/** `SalesTariffEntryType`. */
export const SalesTariffEntry = Obj({
  relativeTimeInterval: RelativeTimeInterval,
  ePriceLevel: Type.Optional(Type.Integer({ minimum: 0 })),
  consumptionCost: Type.Optional(Type.Array(ConsumptionCost, { minItems: 1, maxItems: 3 })),
});
/** One entry of a sales tariff. */
export type SalesTariffEntry = Static<typeof SalesTariffEntry>;

/** `SalesTariffType`: a tariff for ISO 15118 smart charging. */
export const SalesTariff = Obj({
  id: Type.Integer(),
  salesTariffDescription: Type.Optional(Str(32)),
  numEPriceLevels: Type.Optional(Type.Integer()),
  salesTariffEntry: Type.Array(SalesTariffEntry, { minItems: 1, maxItems: 1024 }),
});
/** A sales tariff (ISO 15118). */
export type SalesTariff = Static<typeof SalesTariff>;

/** `ChargingScheduleType`. */
export const ChargingSchedule = Obj({
  id: Type.Integer(),
  startSchedule: Type.Optional(DateTime()),
  duration: Type.Optional(Type.Integer()),
  chargingRateUnit: ChargingRateUnit,
  chargingSchedulePeriod: Type.Array(ChargingSchedulePeriod, { minItems: 1, maxItems: 1024 }),
  minChargingRate: Type.Optional(Type.Number()),
  salesTariff: Type.Optional(SalesTariff),
});
/** A charging schedule. */
export type ChargingSchedule = Static<typeof ChargingSchedule>;

/**
 * `ChargingProfileType`. `chargingSchedule` holds one to three schedules; more than one is only
 * used to offer alternatives to an ISO 15118 EV.
 */
export const ChargingProfile = Obj({
  id: Type.Integer(),
  stackLevel: Type.Integer(),
  chargingProfilePurpose: ChargingProfilePurpose,
  chargingProfileKind: ChargingProfileKind,
  recurrencyKind: Type.Optional(RecurrencyKind),
  validFrom: Type.Optional(DateTime()),
  validTo: Type.Optional(DateTime()),
  transactionId: Type.Optional(Str(36)),
  chargingSchedule: Type.Array(ChargingSchedule, { minItems: 1, maxItems: 3 }),
});
/** A charging profile. */
export type ChargingProfile = Static<typeof ChargingProfile>;

/** `ChargingLimitSourceEnumType`: who set a limit. */
export const ChargingLimitSource = StringEnum(['EMS', 'Other', 'SO', 'CSO']);
/** Who set a charging limit. */
export type ChargingLimitSource = Static<typeof ChargingLimitSource>;

// ---------------------------------------------------------------------------------------------
// Transactions and connectors
// ---------------------------------------------------------------------------------------------

/** `ConnectorStatusEnumType`: the five connector statuses of 2.0.1 (1.6 had nine). */
export const ConnectorStatus = StringEnum([
  'Available',
  'Occupied',
  'Reserved',
  'Unavailable',
  'Faulted',
]);
/** Status of a connector. */
export type ConnectorStatus = Static<typeof ConnectorStatus>;

/** `ConnectorEnumType`: connector (plug) types. */
export const ConnectorKind = StringEnum([
  'cCCS1',
  'cCCS2',
  'cG105',
  'cTesla',
  'cType1',
  'cType2',
  's309-1P-16A',
  's309-1P-32A',
  's309-3P-16A',
  's309-3P-32A',
  'sBS1361',
  'sCEE-7-7',
  'sType2',
  'sType3',
  'Other1PhMax16A',
  'Other1PhOver16A',
  'Other3Ph',
  'Pan',
  'wInductive',
  'wResonant',
  'Undetermined',
  'Unknown',
]);
/** A connector type. */
export type ConnectorKind = Static<typeof ConnectorKind>;
