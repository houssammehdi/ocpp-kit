/**
 * OCPP 2.0.1 Smart Charging (K), Firmware Management (L), Diagnostics (N), Security (A) and
 * Data Transfer (P) messages, written by hand from the specification.
 */
import { Type, type Static } from '@sinclair/typebox';
import {
  ChargingLimitSource,
  ChargingProfile,
  ChargingProfilePurpose,
  ChargingRateUnit,
  ChargingSchedule,
  ChargingSchedulePeriod,
  Component,
  GenericStatus,
  StatusInfo,
  Variable,
} from './datatypes.js';
import { DateTime, EmptyPdu, Obj, Str, StringEnum } from './primitives.js';

// ---------------------------------------------------------------------------------------------
// Smart charging (K)
// ---------------------------------------------------------------------------------------------

/** SetChargingProfileRequest. `evseId` 0 addresses the whole station. */
export const SetChargingProfileRequest = Obj({
  evseId: Type.Integer(),
  chargingProfile: ChargingProfile,
});
/** SetChargingProfileRequest payload. */
export type SetChargingProfileRequest = Static<typeof SetChargingProfileRequest>;

/** SetChargingProfileResponse. */
export const SetChargingProfileResponse = Obj({
  status: GenericStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** SetChargingProfileResponse payload. */
export type SetChargingProfileResponse = Static<typeof SetChargingProfileResponse>;

/** `ChargingProfileCriterionType`: which profiles GetChargingProfiles reports. */
export const ChargingProfileCriterion = Obj({
  chargingProfilePurpose: Type.Optional(ChargingProfilePurpose),
  stackLevel: Type.Optional(Type.Integer()),
  chargingProfileId: Type.Optional(Type.Array(Type.Integer(), { minItems: 1 })),
  chargingLimitSource: Type.Optional(Type.Array(ChargingLimitSource, { minItems: 1, maxItems: 4 })),
});
/** Filter of GetChargingProfiles. */
export type ChargingProfileCriterion = Static<typeof ChargingProfileCriterion>;

/** GetChargingProfilesRequest. The profiles arrive as ReportChargingProfiles messages. */
export const GetChargingProfilesRequest = Obj({
  requestId: Type.Integer(),
  evseId: Type.Optional(Type.Integer()),
  chargingProfile: ChargingProfileCriterion,
});
/** GetChargingProfilesRequest payload. */
export type GetChargingProfilesRequest = Static<typeof GetChargingProfilesRequest>;

/** `GetChargingProfileStatusEnumType`. */
export const GetChargingProfileStatus = StringEnum(['Accepted', 'NoProfiles']);
/** Whether profiles will be reported. */
export type GetChargingProfileStatus = Static<typeof GetChargingProfileStatus>;

/** GetChargingProfilesResponse. */
export const GetChargingProfilesResponse = Obj({
  status: GetChargingProfileStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** GetChargingProfilesResponse payload. */
export type GetChargingProfilesResponse = Static<typeof GetChargingProfilesResponse>;

/** ReportChargingProfilesRequest: the profiles of one EVSE and one limit source. */
export const ReportChargingProfilesRequest = Obj({
  requestId: Type.Integer(),
  chargingLimitSource: ChargingLimitSource,
  chargingProfile: Type.Array(ChargingProfile, { minItems: 1 }),
  tbc: Type.Optional(Type.Boolean()),
  evseId: Type.Integer(),
});
/** ReportChargingProfilesRequest payload. */
export type ReportChargingProfilesRequest = Static<typeof ReportChargingProfilesRequest>;
/** ReportChargingProfilesResponse. */
export const ReportChargingProfilesResponse = EmptyPdu();
/** ReportChargingProfilesResponse payload. */
export type ReportChargingProfilesResponse = Static<typeof ReportChargingProfilesResponse>;

/** `ClearChargingProfileType`: criteria of ClearChargingProfile. */
export const ClearChargingProfileCriteria = Obj({
  evseId: Type.Optional(Type.Integer()),
  chargingProfilePurpose: Type.Optional(ChargingProfilePurpose),
  stackLevel: Type.Optional(Type.Integer()),
});
/** Criteria of ClearChargingProfile. */
export type ClearChargingProfileCriteria = Static<typeof ClearChargingProfileCriteria>;

/** ClearChargingProfileRequest: by id, or every profile matching all given criteria. */
export const ClearChargingProfileRequest = Obj({
  chargingProfileId: Type.Optional(Type.Integer()),
  chargingProfileCriteria: Type.Optional(ClearChargingProfileCriteria),
});
/** ClearChargingProfileRequest payload. */
export type ClearChargingProfileRequest = Static<typeof ClearChargingProfileRequest>;

/** `ClearChargingProfileStatusEnumType`. */
export const ClearChargingProfileStatus = StringEnum(['Accepted', 'Unknown']);
/** Outcome of ClearChargingProfile. */
export type ClearChargingProfileStatus = Static<typeof ClearChargingProfileStatus>;

/** ClearChargingProfileResponse. */
export const ClearChargingProfileResponse = Obj({
  status: ClearChargingProfileStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** ClearChargingProfileResponse payload. */
export type ClearChargingProfileResponse = Static<typeof ClearChargingProfileResponse>;

/** GetCompositeScheduleRequest. */
export const GetCompositeScheduleRequest = Obj({
  duration: Type.Integer(),
  chargingRateUnit: Type.Optional(ChargingRateUnit),
  evseId: Type.Integer(),
});
/** GetCompositeScheduleRequest payload. */
export type GetCompositeScheduleRequest = Static<typeof GetCompositeScheduleRequest>;

/** `CompositeScheduleType`. */
export const CompositeSchedule = Obj({
  chargingSchedulePeriod: Type.Array(ChargingSchedulePeriod, { minItems: 1 }),
  evseId: Type.Integer(),
  duration: Type.Integer(),
  scheduleStart: DateTime(),
  chargingRateUnit: ChargingRateUnit,
});
/** The effective limits of an EVSE. */
export type CompositeSchedule = Static<typeof CompositeSchedule>;

/** GetCompositeScheduleResponse. */
export const GetCompositeScheduleResponse = Obj({
  status: GenericStatus,
  statusInfo: Type.Optional(StatusInfo),
  schedule: Type.Optional(CompositeSchedule),
});
/** GetCompositeScheduleResponse payload. */
export type GetCompositeScheduleResponse = Static<typeof GetCompositeScheduleResponse>;

/** `ChargingLimitType`. */
export const ChargingLimit = Obj({
  chargingLimitSource: ChargingLimitSource,
  isGridCritical: Type.Optional(Type.Boolean()),
});
/** Source of an external limit. */
export type ChargingLimit = Static<typeof ChargingLimit>;

/** NotifyChargingLimitRequest: an external system (e.g. an EMS) set a limit. */
export const NotifyChargingLimitRequest = Obj({
  chargingSchedule: Type.Optional(Type.Array(ChargingSchedule, { minItems: 1 })),
  evseId: Type.Optional(Type.Integer()),
  chargingLimit: ChargingLimit,
});
/** NotifyChargingLimitRequest payload. */
export type NotifyChargingLimitRequest = Static<typeof NotifyChargingLimitRequest>;
/** NotifyChargingLimitResponse. */
export const NotifyChargingLimitResponse = EmptyPdu();
/** NotifyChargingLimitResponse payload. */
export type NotifyChargingLimitResponse = Static<typeof NotifyChargingLimitResponse>;

/** ClearedChargingLimitRequest: an external limit was released. */
export const ClearedChargingLimitRequest = Obj({
  chargingLimitSource: ChargingLimitSource,
  evseId: Type.Optional(Type.Integer()),
});
/** ClearedChargingLimitRequest payload. */
export type ClearedChargingLimitRequest = Static<typeof ClearedChargingLimitRequest>;
/** ClearedChargingLimitResponse. */
export const ClearedChargingLimitResponse = EmptyPdu();
/** ClearedChargingLimitResponse payload. */
export type ClearedChargingLimitResponse = Static<typeof ClearedChargingLimitResponse>;

/** `EnergyTransferModeEnumType`. */
export const EnergyTransferMode = StringEnum([
  'DC',
  'AC_single_phase',
  'AC_two_phase',
  'AC_three_phase',
]);
/** How the EV wants to charge. */
export type EnergyTransferMode = Static<typeof EnergyTransferMode>;

/** `ACChargingParametersType`. */
export const AcChargingParameters = Obj({
  energyAmount: Type.Integer(),
  evMinCurrent: Type.Integer(),
  evMaxCurrent: Type.Integer(),
  evMaxVoltage: Type.Integer(),
});
/** AC charging needs of an EV. */
export type AcChargingParameters = Static<typeof AcChargingParameters>;

/** `DCChargingParametersType`. */
export const DcChargingParameters = Obj({
  evMaxCurrent: Type.Integer(),
  evMaxVoltage: Type.Integer(),
  energyAmount: Type.Optional(Type.Integer()),
  evMaxPower: Type.Optional(Type.Integer()),
  stateOfCharge: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  evEnergyCapacity: Type.Optional(Type.Integer()),
  fullSoC: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  bulkSoC: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
});
/** DC charging needs of an EV. */
export type DcChargingParameters = Static<typeof DcChargingParameters>;

/** `ChargingNeedsType`. */
export const ChargingNeeds = Obj({
  acChargingParameters: Type.Optional(AcChargingParameters),
  dcChargingParameters: Type.Optional(DcChargingParameters),
  requestedEnergyTransfer: EnergyTransferMode,
  departureTime: Type.Optional(DateTime()),
});
/** Charging needs an ISO 15118 EV communicated. */
export type ChargingNeeds = Static<typeof ChargingNeeds>;

/** NotifyEVChargingNeedsRequest (ISO 15118). */
export const NotifyEVChargingNeedsRequest = Obj({
  maxScheduleTuples: Type.Optional(Type.Integer()),
  chargingNeeds: ChargingNeeds,
  evseId: Type.Integer(),
});
/** NotifyEVChargingNeedsRequest payload. */
export type NotifyEVChargingNeedsRequest = Static<typeof NotifyEVChargingNeedsRequest>;

/** `NotifyEVChargingNeedsStatusEnumType`. */
export const NotifyEVChargingNeedsStatus = StringEnum(['Accepted', 'Rejected', 'Processing']);
/** Whether the CSMS will provide a schedule. */
export type NotifyEVChargingNeedsStatus = Static<typeof NotifyEVChargingNeedsStatus>;

/** NotifyEVChargingNeedsResponse. */
export const NotifyEVChargingNeedsResponse = Obj({
  status: NotifyEVChargingNeedsStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** NotifyEVChargingNeedsResponse payload. */
export type NotifyEVChargingNeedsResponse = Static<typeof NotifyEVChargingNeedsResponse>;

// ---------------------------------------------------------------------------------------------
// Firmware management (L)
// ---------------------------------------------------------------------------------------------

/** `FirmwareType`. `signature` and `signingCertificate` make it a secure update (L01). */
export const Firmware = Obj({
  location: Str(512),
  retrieveDateTime: DateTime(),
  installDateTime: Type.Optional(DateTime()),
  signingCertificate: Type.Optional(Str(5500)),
  signature: Type.Optional(Str(800)),
});
/** The firmware to install. */
export type Firmware = Static<typeof Firmware>;

/** UpdateFirmwareRequest. */
export const UpdateFirmwareRequest = Obj({
  retries: Type.Optional(Type.Integer()),
  retryInterval: Type.Optional(Type.Integer()),
  requestId: Type.Integer(),
  firmware: Firmware,
});
/** UpdateFirmwareRequest payload. */
export type UpdateFirmwareRequest = Static<typeof UpdateFirmwareRequest>;

/** `UpdateFirmwareStatusEnumType`. */
export const UpdateFirmwareStatus = StringEnum([
  'Accepted',
  'Rejected',
  'AcceptedCanceled',
  'InvalidCertificate',
  'RevokedCertificate',
]);
/** Outcome of UpdateFirmware. */
export type UpdateFirmwareStatus = Static<typeof UpdateFirmwareStatus>;

/** UpdateFirmwareResponse. */
export const UpdateFirmwareResponse = Obj({
  status: UpdateFirmwareStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** UpdateFirmwareResponse payload. */
export type UpdateFirmwareResponse = Static<typeof UpdateFirmwareResponse>;

/** `FirmwareStatusEnumType`. */
export const FirmwareStatus = StringEnum([
  'Downloaded',
  'DownloadFailed',
  'Downloading',
  'DownloadScheduled',
  'DownloadPaused',
  'Idle',
  'InstallationFailed',
  'Installing',
  'Installed',
  'InstallRebooting',
  'InstallScheduled',
  'InstallVerificationFailed',
  'InvalidSignature',
  'SignatureVerified',
]);
/** Progress of a firmware update. */
export type FirmwareStatus = Static<typeof FirmwareStatus>;

/** FirmwareStatusNotificationRequest. */
export const FirmwareStatusNotificationRequest = Obj({
  status: FirmwareStatus,
  requestId: Type.Optional(Type.Integer()),
});
/** FirmwareStatusNotificationRequest payload. */
export type FirmwareStatusNotificationRequest = Static<typeof FirmwareStatusNotificationRequest>;
/** FirmwareStatusNotificationResponse. */
export const FirmwareStatusNotificationResponse = EmptyPdu();
/** FirmwareStatusNotificationResponse payload. */
export type FirmwareStatusNotificationResponse = Static<typeof FirmwareStatusNotificationResponse>;

// ---------------------------------------------------------------------------------------------
// Diagnostics (N)
// ---------------------------------------------------------------------------------------------

/** `LogEnumType`. */
export const LogKind = StringEnum(['DiagnosticsLog', 'SecurityLog']);
/** Which log to upload. */
export type LogKind = Static<typeof LogKind>;

/** `LogParametersType`. */
export const LogParameters = Obj({
  remoteLocation: Str(512),
  oldestTimestamp: Type.Optional(DateTime()),
  latestTimestamp: Type.Optional(DateTime()),
});
/** Where to upload a log, and which time window. */
export type LogParameters = Static<typeof LogParameters>;

/** GetLogRequest. */
export const GetLogRequest = Obj({
  log: LogParameters,
  logType: LogKind,
  requestId: Type.Integer(),
  retries: Type.Optional(Type.Integer()),
  retryInterval: Type.Optional(Type.Integer()),
});
/** GetLogRequest payload. */
export type GetLogRequest = Static<typeof GetLogRequest>;

/** `LogStatusEnumType`. */
export const LogStatus = StringEnum(['Accepted', 'Rejected', 'AcceptedCanceled']);
/** Outcome of GetLog. */
export type LogStatus = Static<typeof LogStatus>;

/** GetLogResponse. */
export const GetLogResponse = Obj({
  status: LogStatus,
  statusInfo: Type.Optional(StatusInfo),
  filename: Type.Optional(Str(255)),
});
/** GetLogResponse payload. */
export type GetLogResponse = Static<typeof GetLogResponse>;

/** `UploadLogStatusEnumType`. */
export const UploadLogStatus = StringEnum([
  'BadMessage',
  'Idle',
  'NotSupportedOperation',
  'PermissionDenied',
  'Uploaded',
  'UploadFailure',
  'Uploading',
  'AcceptedCanceled',
]);
/** Progress of a log upload. */
export type UploadLogStatus = Static<typeof UploadLogStatus>;

/** LogStatusNotificationRequest. */
export const LogStatusNotificationRequest = Obj({
  status: UploadLogStatus,
  requestId: Type.Optional(Type.Integer()),
});
/** LogStatusNotificationRequest payload. */
export type LogStatusNotificationRequest = Static<typeof LogStatusNotificationRequest>;
/** LogStatusNotificationResponse. */
export const LogStatusNotificationResponse = EmptyPdu();
/** LogStatusNotificationResponse payload. */
export type LogStatusNotificationResponse = Static<typeof LogStatusNotificationResponse>;

/** `EventTriggerEnumType`. */
export const EventTrigger = StringEnum(['Alerting', 'Delta', 'Periodic']);
/** What triggered an event. */
export type EventTrigger = Static<typeof EventTrigger>;

/** `EventNotificationEnumType`. */
export const EventNotificationKind = StringEnum([
  'HardWiredNotification',
  'HardWiredMonitor',
  'PreconfiguredMonitor',
  'CustomMonitor',
]);
/** Where an event comes from. */
export type EventNotificationKind = Static<typeof EventNotificationKind>;

/** `EventDataType`: one event of a NotifyEvent. */
export const EventData = Obj({
  eventId: Type.Integer(),
  timestamp: DateTime(),
  trigger: EventTrigger,
  cause: Type.Optional(Type.Integer()),
  actualValue: Str(2500),
  techCode: Type.Optional(Str(50)),
  techInfo: Type.Optional(Str(500)),
  cleared: Type.Optional(Type.Boolean()),
  transactionId: Type.Optional(Str(36)),
  component: Component,
  variableMonitoringId: Type.Optional(Type.Integer()),
  eventNotificationType: EventNotificationKind,
  variable: Variable,
});
/** One device model event. */
export type EventData = Static<typeof EventData>;

/** NotifyEventRequest: device model events, possibly in several parts (`tbc`, `seqNo`). */
export const NotifyEventRequest = Obj({
  generatedAt: DateTime(),
  tbc: Type.Optional(Type.Boolean()),
  seqNo: Type.Integer(),
  eventData: Type.Array(EventData, { minItems: 1 }),
});
/** NotifyEventRequest payload. */
export type NotifyEventRequest = Static<typeof NotifyEventRequest>;
/** NotifyEventResponse. */
export const NotifyEventResponse = EmptyPdu();
/** NotifyEventResponse payload. */
export type NotifyEventResponse = Static<typeof NotifyEventResponse>;

// ---------------------------------------------------------------------------------------------
// Security (A) and data transfer (P)
// ---------------------------------------------------------------------------------------------

/**
 * SecurityEventNotificationRequest. `type` is one of the security events the specification
 * lists (e.g. `FirmwareUpdated`, `SettingSystemTime`, `StartupOfTheDevice`) or a vendor event.
 */
export const SecurityEventNotificationRequest = Obj({
  type: Str(50),
  timestamp: DateTime(),
  techInfo: Type.Optional(Str(255)),
});
/** SecurityEventNotificationRequest payload. */
export type SecurityEventNotificationRequest = Static<typeof SecurityEventNotificationRequest>;
/** SecurityEventNotificationResponse. */
export const SecurityEventNotificationResponse = EmptyPdu();
/** SecurityEventNotificationResponse payload. */
export type SecurityEventNotificationResponse = Static<typeof SecurityEventNotificationResponse>;

/** DataTransferRequest. Unlike 1.6, `data` may be any JSON value. */
export const DataTransferRequest = Obj({
  messageId: Type.Optional(Str(50)),
  data: Type.Optional(Type.Unknown()),
  vendorId: Str(255),
});
/** DataTransferRequest payload. */
export type DataTransferRequest = Static<typeof DataTransferRequest>;

/** `DataTransferStatusEnumType`. */
export const DataTransferStatus = StringEnum([
  'Accepted',
  'Rejected',
  'UnknownMessageId',
  'UnknownVendorId',
]);
/** Outcome of DataTransfer. */
export type DataTransferStatus = Static<typeof DataTransferStatus>;

/** DataTransferResponse. */
export const DataTransferResponse = Obj({
  status: DataTransferStatus,
  statusInfo: Type.Optional(StatusInfo),
  data: Type.Optional(Type.Unknown()),
});
/** DataTransferResponse payload. */
export type DataTransferResponse = Static<typeof DataTransferResponse>;
