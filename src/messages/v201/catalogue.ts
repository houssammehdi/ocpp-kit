import { OCPP201_ERROR_CODES } from '../../rpc/errors.js';
import type { OcppProtocol } from '../../rpc/protocol.js';
import type { ActionName, RequestOf, ResponseOf } from '../../rpc/validation.js';
import * as mg from './management.js';
import * as pv from './provisioning.js';
import * as tx from './transactions.js';

/**
 * OCPP 2.0.1 actions a Charging Station sends to the CSMS, with their request/response schemas.
 * Drives runtime validation and the static types of `call()` and `handle()`.
 */
export const ChargingStationToCsms = {
  // Provisioning
  BootNotification: { request: pv.BootNotificationRequest, response: pv.BootNotificationResponse },
  NotifyReport: { request: pv.NotifyReportRequest, response: pv.NotifyReportResponse },
  // Authorization
  Authorize: { request: tx.AuthorizeRequest, response: tx.AuthorizeResponse },
  // Transactions
  TransactionEvent: { request: tx.TransactionEventRequest, response: tx.TransactionEventResponse },
  // Availability
  Heartbeat: { request: pv.HeartbeatRequest, response: pv.HeartbeatResponse },
  StatusNotification: {
    request: pv.StatusNotificationRequest,
    response: pv.StatusNotificationResponse,
  },
  // Reservation
  ReservationStatusUpdate: {
    request: tx.ReservationStatusUpdateRequest,
    response: tx.ReservationStatusUpdateResponse,
  },
  // Metering
  MeterValues: { request: tx.MeterValuesRequest, response: tx.MeterValuesResponse },
  // Smart charging
  ReportChargingProfiles: {
    request: mg.ReportChargingProfilesRequest,
    response: mg.ReportChargingProfilesResponse,
  },
  NotifyChargingLimit: {
    request: mg.NotifyChargingLimitRequest,
    response: mg.NotifyChargingLimitResponse,
  },
  ClearedChargingLimit: {
    request: mg.ClearedChargingLimitRequest,
    response: mg.ClearedChargingLimitResponse,
  },
  NotifyEVChargingNeeds: {
    request: mg.NotifyEVChargingNeedsRequest,
    response: mg.NotifyEVChargingNeedsResponse,
  },
  // Firmware management
  FirmwareStatusNotification: {
    request: mg.FirmwareStatusNotificationRequest,
    response: mg.FirmwareStatusNotificationResponse,
  },
  // Diagnostics
  LogStatusNotification: {
    request: mg.LogStatusNotificationRequest,
    response: mg.LogStatusNotificationResponse,
  },
  NotifyEvent: { request: mg.NotifyEventRequest, response: mg.NotifyEventResponse },
  // Security
  SecurityEventNotification: {
    request: mg.SecurityEventNotificationRequest,
    response: mg.SecurityEventNotificationResponse,
  },
  // Data transfer
  DataTransfer: { request: mg.DataTransferRequest, response: mg.DataTransferResponse },
} as const;

/** OCPP 2.0.1 actions the CSMS sends to a Charging Station. */
export const CsmsToChargingStation = {
  // Provisioning
  GetVariables: { request: pv.GetVariablesRequest, response: pv.GetVariablesResponse },
  SetVariables: { request: pv.SetVariablesRequest, response: pv.SetVariablesResponse },
  GetBaseReport: { request: pv.GetBaseReportRequest, response: pv.GetBaseReportResponse },
  GetReport: { request: pv.GetReportRequest, response: pv.GetReportResponse },
  Reset: { request: pv.ResetRequest, response: pv.ResetResponse },
  SetNetworkProfile: {
    request: pv.SetNetworkProfileRequest,
    response: pv.SetNetworkProfileResponse,
  },
  // Authorization
  ClearCache: { request: tx.ClearCacheRequest, response: tx.ClearCacheResponse },
  // Local authorization list
  GetLocalListVersion: {
    request: tx.GetLocalListVersionRequest,
    response: tx.GetLocalListVersionResponse,
  },
  SendLocalList: { request: tx.SendLocalListRequest, response: tx.SendLocalListResponse },
  // Transactions
  GetTransactionStatus: {
    request: tx.GetTransactionStatusRequest,
    response: tx.GetTransactionStatusResponse,
  },
  // Remote control
  RequestStartTransaction: {
    request: tx.RequestStartTransactionRequest,
    response: tx.RequestStartTransactionResponse,
  },
  RequestStopTransaction: {
    request: tx.RequestStopTransactionRequest,
    response: tx.RequestStopTransactionResponse,
  },
  TriggerMessage: { request: tx.TriggerMessageRequest, response: tx.TriggerMessageResponse },
  UnlockConnector: { request: tx.UnlockConnectorRequest, response: tx.UnlockConnectorResponse },
  // Availability
  ChangeAvailability: {
    request: pv.ChangeAvailabilityRequest,
    response: pv.ChangeAvailabilityResponse,
  },
  // Reservation
  ReserveNow: { request: tx.ReserveNowRequest, response: tx.ReserveNowResponse },
  CancelReservation: {
    request: tx.CancelReservationRequest,
    response: tx.CancelReservationResponse,
  },
  // Smart charging
  SetChargingProfile: {
    request: mg.SetChargingProfileRequest,
    response: mg.SetChargingProfileResponse,
  },
  GetChargingProfiles: {
    request: mg.GetChargingProfilesRequest,
    response: mg.GetChargingProfilesResponse,
  },
  ClearChargingProfile: {
    request: mg.ClearChargingProfileRequest,
    response: mg.ClearChargingProfileResponse,
  },
  GetCompositeSchedule: {
    request: mg.GetCompositeScheduleRequest,
    response: mg.GetCompositeScheduleResponse,
  },
  // Firmware management
  UpdateFirmware: { request: mg.UpdateFirmwareRequest, response: mg.UpdateFirmwareResponse },
  // Diagnostics
  GetLog: { request: mg.GetLogRequest, response: mg.GetLogResponse },
  // Data transfer
  DataTransfer: { request: mg.DataTransferRequest, response: mg.DataTransferResponse },
} as const;

/** Schema map of Charging Station initiated actions. */
export type ChargingStationToCsms = typeof ChargingStationToCsms;
/** Schema map of CSMS initiated actions. */
export type CsmsToChargingStation = typeof CsmsToChargingStation;

/** Name of an OCPP 2.0.1 action initiated by the Charging Station. */
export type StationAction = ActionName<ChargingStationToCsms>;
/** Name of an OCPP 2.0.1 action initiated by the CSMS. */
export type CsmsAction = ActionName<CsmsToChargingStation>;
/** Any OCPP 2.0.1 action in the catalogue (DataTransfer exists in both directions). */
export type Action201 = StationAction | CsmsAction;

/** Request payload of a Charging Station initiated action, e.g. `StationRequest<'Authorize'>`. */
export type StationRequest<A extends StationAction> = RequestOf<ChargingStationToCsms, A>;
/** Response payload of a Charging Station initiated action. */
export type StationResponse<A extends StationAction> = ResponseOf<ChargingStationToCsms, A>;
/** Request payload of a CSMS initiated action. */
export type CsmsRequest<A extends CsmsAction> = RequestOf<CsmsToChargingStation, A>;
/** Response payload of a CSMS initiated action. */
export type CsmsResponse<A extends CsmsAction> = ResponseOf<CsmsToChargingStation, A>;

/**
 * The functional blocks of OCPP 2.0.1 Part 2 that the catalogue covers, with the letter of their
 * use cases (e.g. B01 is the first Provisioning use case).
 */
export const FUNCTIONAL_BLOCKS = {
  Security: 'A',
  Provisioning: 'B',
  Authorization: 'C',
  LocalAuthorizationListManagement: 'D',
  Transactions: 'E',
  RemoteControl: 'F',
  Availability: 'G',
  Reservation: 'H',
  MeterValues: 'J',
  SmartCharging: 'K',
  FirmwareManagement: 'L',
  Diagnostics: 'N',
  DataTransfer: 'P',
} as const;

/** An OCPP 2.0.1 functional block. */
export type FunctionalBlock = keyof typeof FUNCTIONAL_BLOCKS;

/** The functional block each action of the catalogue belongs to. */
export const ACTION_BLOCKS: Readonly<Record<Action201, FunctionalBlock>> = {
  SecurityEventNotification: 'Security',
  BootNotification: 'Provisioning',
  GetBaseReport: 'Provisioning',
  GetReport: 'Provisioning',
  GetVariables: 'Provisioning',
  NotifyReport: 'Provisioning',
  Reset: 'Provisioning',
  SetNetworkProfile: 'Provisioning',
  SetVariables: 'Provisioning',
  Authorize: 'Authorization',
  ClearCache: 'Authorization',
  GetLocalListVersion: 'LocalAuthorizationListManagement',
  SendLocalList: 'LocalAuthorizationListManagement',
  GetTransactionStatus: 'Transactions',
  TransactionEvent: 'Transactions',
  RequestStartTransaction: 'RemoteControl',
  RequestStopTransaction: 'RemoteControl',
  TriggerMessage: 'RemoteControl',
  UnlockConnector: 'RemoteControl',
  ChangeAvailability: 'Availability',
  Heartbeat: 'Availability',
  StatusNotification: 'Availability',
  CancelReservation: 'Reservation',
  ReservationStatusUpdate: 'Reservation',
  ReserveNow: 'Reservation',
  MeterValues: 'MeterValues',
  ClearChargingProfile: 'SmartCharging',
  ClearedChargingLimit: 'SmartCharging',
  GetChargingProfiles: 'SmartCharging',
  GetCompositeSchedule: 'SmartCharging',
  NotifyChargingLimit: 'SmartCharging',
  NotifyEVChargingNeeds: 'SmartCharging',
  ReportChargingProfiles: 'SmartCharging',
  SetChargingProfile: 'SmartCharging',
  FirmwareStatusNotification: 'FirmwareManagement',
  UpdateFirmware: 'FirmwareManagement',
  GetLog: 'Diagnostics',
  LogStatusNotification: 'Diagnostics',
  NotifyEvent: 'Diagnostics',
  DataTransfer: 'DataTransfer',
};

/**
 * The OCPP 2.0.1 messages ocpp-kit does not implement (24 of the 64): certificate management,
 * display messages, variable monitoring, tariff and cost, customer information, ISO 15118
 * schedules and local firmware publishing.
 */
export const UNSUPPORTED_ACTIONS_201 = [
  'CertificateSigned',
  'ClearDisplayMessage',
  'ClearVariableMonitoring',
  'CostUpdated',
  'CustomerInformation',
  'DeleteCertificate',
  'Get15118EVCertificate',
  'GetCertificateStatus',
  'GetDisplayMessages',
  'GetInstalledCertificateIds',
  'GetMonitoringReport',
  'InstallCertificate',
  'NotifyCustomerInformation',
  'NotifyDisplayMessages',
  'NotifyEVChargingSchedule',
  'NotifyMonitoringReport',
  'PublishFirmware',
  'PublishFirmwareStatusNotification',
  'SetDisplayMessage',
  'SetMonitoringBase',
  'SetMonitoringLevel',
  'SetVariableMonitoring',
  'SignCertificate',
  'UnpublishFirmware',
] as const;

/** OCPP 2.0.1 as a protocol definition for the version-generic layers. */
export const OCPP201_PROTOCOL: OcppProtocol<'2.0.1', ChargingStationToCsms, CsmsToChargingStation> =
  {
    version: '2.0.1',
    name: 'OCPP 2.0.1',
    subprotocol: 'ocpp2.0.1',
    errorCodes: OCPP201_ERROR_CODES,
    fromChargePoint: ChargingStationToCsms,
    fromCentralSystem: CsmsToChargingStation,
    transactionActions: ['TransactionEvent'],
  };
