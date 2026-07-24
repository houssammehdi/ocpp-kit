/**
 * OCPP 2.0.1 Provisioning (functional block B) and Availability (G) messages, written by hand
 * from the specification. Every object forbids undeclared properties except `customData`.
 */
import { Type, type Static } from '@sinclair/typebox';
import {
  AttributeKind,
  Component,
  ConnectorStatus,
  Evse,
  ReportData,
  StatusInfo,
  Variable,
} from './datatypes.js';
import { DateTime, EmptyPdu, Obj, Str, StringEnum } from './primitives.js';

// ---------------------------------------------------------------------------------------------
// BootNotification (B01-B04)
// ---------------------------------------------------------------------------------------------

/** `ModemType`. */
export const Modem = Obj({ iccid: Type.Optional(Str(20)), imsi: Type.Optional(Str(20)) });
/** Modem identification. */
export type Modem = Static<typeof Modem>;

/** `ChargingStationType`: what the station reports about itself at boot. */
export const ChargingStationInfo = Obj({
  serialNumber: Type.Optional(Str(25)),
  model: Str(20),
  modem: Type.Optional(Modem),
  vendorName: Str(50),
  firmwareVersion: Type.Optional(Str(50)),
});
/** Station identification sent in BootNotification. */
export type ChargingStationInfo = Static<typeof ChargingStationInfo>;

/** `BootReasonEnumType`: why the station (re)booted. */
export const BootReason = StringEnum([
  'ApplicationReset',
  'FirmwareUpdate',
  'LocalReset',
  'PowerUp',
  'RemoteReset',
  'ScheduledReset',
  'Triggered',
  'Unknown',
  'Watchdog',
]);
/** Why the station booted. */
export type BootReason = Static<typeof BootReason>;

/** BootNotificationRequest. */
export const BootNotificationRequest = Obj({
  chargingStation: ChargingStationInfo,
  reason: BootReason,
});
/** BootNotificationRequest payload. */
export type BootNotificationRequest = Static<typeof BootNotificationRequest>;

/** `RegistrationStatusEnumType`. */
export const RegistrationStatus = StringEnum(['Accepted', 'Pending', 'Rejected']);
/** Registration outcome. */
export type RegistrationStatus = Static<typeof RegistrationStatus>;

/**
 * BootNotificationResponse. When Accepted, `interval` is the heartbeat interval; otherwise the
 * time to wait before the next BootNotification.
 */
export const BootNotificationResponse = Obj({
  currentTime: DateTime(),
  interval: Type.Integer(),
  status: RegistrationStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** BootNotificationResponse payload. */
export type BootNotificationResponse = Static<typeof BootNotificationResponse>;

// ---------------------------------------------------------------------------------------------
// Device model: GetVariables, SetVariables, GetBaseReport, GetReport, NotifyReport (B05-B08)
// ---------------------------------------------------------------------------------------------

/** `GetVariableDataType`: one variable to read. */
export const GetVariableData = Obj({
  attributeType: Type.Optional(AttributeKind),
  component: Component,
  variable: Variable,
});
/** One variable to read. */
export type GetVariableData = Static<typeof GetVariableData>;

/** GetVariablesRequest. */
export const GetVariablesRequest = Obj({
  getVariableData: Type.Array(GetVariableData, { minItems: 1 }),
});
/** GetVariablesRequest payload. */
export type GetVariablesRequest = Static<typeof GetVariablesRequest>;

/** `GetVariableStatusEnumType`. */
export const GetVariableStatus = StringEnum([
  'Accepted',
  'Rejected',
  'UnknownComponent',
  'UnknownVariable',
  'NotSupportedAttributeType',
]);
/** Outcome of reading one variable. */
export type GetVariableStatus = Static<typeof GetVariableStatus>;

/** `GetVariableResultType`. */
export const GetVariableResult = Obj({
  attributeStatus: GetVariableStatus,
  attributeStatusInfo: Type.Optional(StatusInfo),
  attributeType: Type.Optional(AttributeKind),
  attributeValue: Type.Optional(Str(2500)),
  component: Component,
  variable: Variable,
});
/** Result of reading one variable. */
export type GetVariableResult = Static<typeof GetVariableResult>;

/** GetVariablesResponse. */
export const GetVariablesResponse = Obj({
  getVariableResult: Type.Array(GetVariableResult, { minItems: 1 }),
});
/** GetVariablesResponse payload. */
export type GetVariablesResponse = Static<typeof GetVariablesResponse>;

/** `SetVariableDataType`: one variable to write. */
export const SetVariableData = Obj({
  attributeType: Type.Optional(AttributeKind),
  attributeValue: Str(1000),
  component: Component,
  variable: Variable,
});
/** One variable to write. */
export type SetVariableData = Static<typeof SetVariableData>;

/** SetVariablesRequest. */
export const SetVariablesRequest = Obj({
  setVariableData: Type.Array(SetVariableData, { minItems: 1 }),
});
/** SetVariablesRequest payload. */
export type SetVariablesRequest = Static<typeof SetVariablesRequest>;

/** `SetVariableStatusEnumType`. */
export const SetVariableStatus = StringEnum([
  'Accepted',
  'Rejected',
  'UnknownComponent',
  'UnknownVariable',
  'NotSupportedAttributeType',
  'RebootRequired',
]);
/** Outcome of writing one variable. */
export type SetVariableStatus = Static<typeof SetVariableStatus>;

/** `SetVariableResultType`. */
export const SetVariableResult = Obj({
  attributeType: Type.Optional(AttributeKind),
  attributeStatus: SetVariableStatus,
  attributeStatusInfo: Type.Optional(StatusInfo),
  component: Component,
  variable: Variable,
});
/** Result of writing one variable. */
export type SetVariableResult = Static<typeof SetVariableResult>;

/** SetVariablesResponse. */
export const SetVariablesResponse = Obj({
  setVariableResult: Type.Array(SetVariableResult, { minItems: 1 }),
});
/** SetVariablesResponse payload. */
export type SetVariablesResponse = Static<typeof SetVariablesResponse>;

/** `ReportBaseEnumType`. */
export const ReportBase = StringEnum([
  'ConfigurationInventory',
  'FullInventory',
  'SummaryInventory',
]);
/** Which predefined report to generate. */
export type ReportBase = Static<typeof ReportBase>;

/** GetBaseReportRequest. The report itself arrives as NotifyReport messages. */
export const GetBaseReportRequest = Obj({ requestId: Type.Integer(), reportBase: ReportBase });
/** GetBaseReportRequest payload. */
export type GetBaseReportRequest = Static<typeof GetBaseReportRequest>;

/** `GenericDeviceModelStatusEnumType`. */
export const GenericDeviceModelStatus = StringEnum([
  'Accepted',
  'Rejected',
  'NotSupported',
  'EmptyResultSet',
]);
/** Whether a report will be sent. */
export type GenericDeviceModelStatus = Static<typeof GenericDeviceModelStatus>;

/** GetBaseReportResponse. */
export const GetBaseReportResponse = Obj({
  status: GenericDeviceModelStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** GetBaseReportResponse payload. */
export type GetBaseReportResponse = Static<typeof GetBaseReportResponse>;

/** `ComponentCriterionEnumType`. */
export const ComponentCriterion = StringEnum(['Active', 'Available', 'Enabled', 'Problem']);
/** Component filter of GetReport. */
export type ComponentCriterion = Static<typeof ComponentCriterion>;

/** `ComponentVariableType`: a component, optionally narrowed to one variable. */
export const ComponentVariable = Obj({
  component: Component,
  variable: Type.Optional(Variable),
});
/** A component, optionally narrowed to one variable. */
export type ComponentVariable = Static<typeof ComponentVariable>;

/** GetReportRequest: a custom report of selected components and variables. */
export const GetReportRequest = Obj({
  componentVariable: Type.Optional(Type.Array(ComponentVariable, { minItems: 1 })),
  requestId: Type.Integer(),
  componentCriteria: Type.Optional(Type.Array(ComponentCriterion, { minItems: 1, maxItems: 4 })),
});
/** GetReportRequest payload. */
export type GetReportRequest = Static<typeof GetReportRequest>;

/** GetReportResponse. */
export const GetReportResponse = GetBaseReportResponse;
/** GetReportResponse payload. */
export type GetReportResponse = Static<typeof GetReportResponse>;

/**
 * NotifyReportRequest: one part of a report. `seqNo` numbers the parts from 0; `tbc` ("to be
 * continued") is true on every part but the last.
 */
export const NotifyReportRequest = Obj({
  requestId: Type.Integer(),
  generatedAt: DateTime(),
  reportData: Type.Optional(Type.Array(ReportData, { minItems: 1 })),
  tbc: Type.Optional(Type.Boolean()),
  seqNo: Type.Integer(),
});
/** NotifyReportRequest payload. */
export type NotifyReportRequest = Static<typeof NotifyReportRequest>;
/** NotifyReportResponse. */
export const NotifyReportResponse = EmptyPdu();
/** NotifyReportResponse payload. */
export type NotifyReportResponse = Static<typeof NotifyReportResponse>;

// ---------------------------------------------------------------------------------------------
// Reset (B11, B12)
// ---------------------------------------------------------------------------------------------

/** `ResetEnumType`: `Immediate` stops transactions first, `OnIdle` waits for them to end. */
export const ResetKind = StringEnum(['Immediate', 'OnIdle']);
/** Kind of reset. */
export type ResetKind = Static<typeof ResetKind>;

/** ResetRequest. With `evseId`, only that EVSE is reset. */
export const ResetRequest = Obj({ type: ResetKind, evseId: Type.Optional(Type.Integer()) });
/** ResetRequest payload. */
export type ResetRequest = Static<typeof ResetRequest>;

/** `ResetStatusEnumType`. */
export const ResetStatus = StringEnum(['Accepted', 'Rejected', 'Scheduled']);
/** Outcome of a reset request. */
export type ResetStatus = Static<typeof ResetStatus>;

/** ResetResponse. */
export const ResetResponse = Obj({ status: ResetStatus, statusInfo: Type.Optional(StatusInfo) });
/** ResetResponse payload. */
export type ResetResponse = Static<typeof ResetResponse>;

// ---------------------------------------------------------------------------------------------
// SetNetworkProfile (B09)
// ---------------------------------------------------------------------------------------------

/** `APNAuthenticationEnumType`. */
export const ApnAuthentication = StringEnum(['CHAP', 'NONE', 'PAP', 'AUTO']);
/** APN authentication method. */
export type ApnAuthentication = Static<typeof ApnAuthentication>;

/** `APNType`: mobile data settings. */
export const Apn = Obj({
  apn: Str(512),
  apnUserName: Type.Optional(Str(20)),
  apnPassword: Type.Optional(Str(20)),
  simPin: Type.Optional(Type.Integer()),
  preferredNetwork: Type.Optional(Str(6)),
  useOnlyPreferredNetwork: Type.Optional(Type.Boolean()),
  apnAuthentication: ApnAuthentication,
});
/** Mobile data settings. */
export type Apn = Static<typeof Apn>;

/** `VPNEnumType`. */
export const VpnKind = StringEnum(['IKEv2', 'IPSec', 'L2TP', 'PPTP']);
/** VPN type. */
export type VpnKind = Static<typeof VpnKind>;

/** `VPNType`. */
export const Vpn = Obj({
  server: Str(512),
  user: Str(20),
  group: Type.Optional(Str(20)),
  password: Str(20),
  key: Str(255),
  type: VpnKind,
});
/** VPN settings. */
export type Vpn = Static<typeof Vpn>;

/** `OCPPVersionEnumType`. */
export const OcppVersionName = StringEnum(['OCPP12', 'OCPP15', 'OCPP16', 'OCPP20']);
/** OCPP version of a network profile (`OCPP20` stands for 2.0 and 2.0.1). */
export type OcppVersionName = Static<typeof OcppVersionName>;

/** `OCPPTransportEnumType`. */
export const OcppTransport = StringEnum(['JSON', 'SOAP']);
/** Transport of a network profile. */
export type OcppTransport = Static<typeof OcppTransport>;

/** `OCPPInterfaceEnumType`. */
export const OcppInterface = StringEnum([
  'Wired0',
  'Wired1',
  'Wired2',
  'Wired3',
  'Wireless0',
  'Wireless1',
  'Wireless2',
  'Wireless3',
]);
/** Network interface of a network profile. */
export type OcppInterface = Static<typeof OcppInterface>;

/** `NetworkConnectionProfileType`. */
export const NetworkConnectionProfile = Obj({
  apn: Type.Optional(Apn),
  ocppVersion: OcppVersionName,
  ocppTransport: OcppTransport,
  ocppCsmsUrl: Str(512),
  messageTimeout: Type.Integer(),
  securityProfile: Type.Integer(),
  ocppInterface: OcppInterface,
  vpn: Type.Optional(Vpn),
});
/** How to reach a CSMS. */
export type NetworkConnectionProfile = Static<typeof NetworkConnectionProfile>;

/** SetNetworkProfileRequest. */
export const SetNetworkProfileRequest = Obj({
  configurationSlot: Type.Integer(),
  connectionData: NetworkConnectionProfile,
});
/** SetNetworkProfileRequest payload. */
export type SetNetworkProfileRequest = Static<typeof SetNetworkProfileRequest>;

/** `SetNetworkProfileStatusEnumType`. */
export const SetNetworkProfileStatus = StringEnum(['Accepted', 'Rejected', 'Failed']);
/** Outcome of SetNetworkProfile. */
export type SetNetworkProfileStatus = Static<typeof SetNetworkProfileStatus>;

/** SetNetworkProfileResponse. */
export const SetNetworkProfileResponse = Obj({
  status: SetNetworkProfileStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** SetNetworkProfileResponse payload. */
export type SetNetworkProfileResponse = Static<typeof SetNetworkProfileResponse>;

// ---------------------------------------------------------------------------------------------
// Availability: Heartbeat, StatusNotification, ChangeAvailability (G01-G04)
// ---------------------------------------------------------------------------------------------

/** HeartbeatRequest (no fields). */
export const HeartbeatRequest = EmptyPdu();
/** HeartbeatRequest payload. */
export type HeartbeatRequest = Static<typeof HeartbeatRequest>;
/** HeartbeatResponse: the CSMS clock. */
export const HeartbeatResponse = Obj({ currentTime: DateTime() });
/** HeartbeatResponse payload. */
export type HeartbeatResponse = Static<typeof HeartbeatResponse>;

/** StatusNotificationRequest: the status of one connector of one EVSE. */
export const StatusNotificationRequest = Obj({
  timestamp: DateTime(),
  connectorStatus: ConnectorStatus,
  evseId: Type.Integer(),
  connectorId: Type.Integer(),
});
/** StatusNotificationRequest payload. */
export type StatusNotificationRequest = Static<typeof StatusNotificationRequest>;
/** StatusNotificationResponse. */
export const StatusNotificationResponse = EmptyPdu();
/** StatusNotificationResponse payload. */
export type StatusNotificationResponse = Static<typeof StatusNotificationResponse>;

/** `OperationalStatusEnumType`. */
export const OperationalStatus = StringEnum(['Inoperative', 'Operative']);
/** Target availability. */
export type OperationalStatus = Static<typeof OperationalStatus>;

/** ChangeAvailabilityRequest. Without `evse` it addresses the whole station. */
export const ChangeAvailabilityRequest = Obj({
  evse: Type.Optional(Evse),
  operationalStatus: OperationalStatus,
});
/** ChangeAvailabilityRequest payload. */
export type ChangeAvailabilityRequest = Static<typeof ChangeAvailabilityRequest>;

/** `ChangeAvailabilityStatusEnumType`. */
export const ChangeAvailabilityStatus = StringEnum(['Accepted', 'Rejected', 'Scheduled']);
/** Outcome of ChangeAvailability. */
export type ChangeAvailabilityStatus = Static<typeof ChangeAvailabilityStatus>;

/** ChangeAvailabilityResponse. */
export const ChangeAvailabilityResponse = Obj({
  status: ChangeAvailabilityStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** ChangeAvailabilityResponse payload. */
export type ChangeAvailabilityResponse = Static<typeof ChangeAvailabilityResponse>;
