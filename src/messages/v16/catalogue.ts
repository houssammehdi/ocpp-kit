import type { ActionName, RequestOf, ResponseOf } from '../../rpc/validation.js';
import * as core from './core.js';
import * as fw from './firmware.js';
import * as lal from './local-auth-list.js';
import * as rt from './remote-trigger.js';
import * as res from './reservation.js';
import * as sc from './smart-charging.js';

/**
 * Actions a Charge Point sends to the Central System, with their request/response schemas.
 * This object drives both runtime validation and the static types of `call()` and `handle()`.
 */
export const ChargePointToCentralSystem = {
  // Core
  Authorize: { request: core.AuthorizeRequest, response: core.AuthorizeResponse },
  BootNotification: {
    request: core.BootNotificationRequest,
    response: core.BootNotificationResponse,
  },
  DataTransfer: { request: core.DataTransferRequest, response: core.DataTransferResponse },
  Heartbeat: { request: core.HeartbeatRequest, response: core.HeartbeatResponse },
  MeterValues: { request: core.MeterValuesRequest, response: core.MeterValuesResponse },
  StartTransaction: {
    request: core.StartTransactionRequest,
    response: core.StartTransactionResponse,
  },
  StatusNotification: {
    request: core.StatusNotificationRequest,
    response: core.StatusNotificationResponse,
  },
  StopTransaction: { request: core.StopTransactionRequest, response: core.StopTransactionResponse },
  // Firmware Management
  DiagnosticsStatusNotification: {
    request: fw.DiagnosticsStatusNotificationRequest,
    response: fw.DiagnosticsStatusNotificationResponse,
  },
  FirmwareStatusNotification: {
    request: fw.FirmwareStatusNotificationRequest,
    response: fw.FirmwareStatusNotificationResponse,
  },
} as const;

/** Actions the Central System sends to a Charge Point. */
export const CentralSystemToChargePoint = {
  // Core
  ChangeAvailability: {
    request: core.ChangeAvailabilityRequest,
    response: core.ChangeAvailabilityResponse,
  },
  ChangeConfiguration: {
    request: core.ChangeConfigurationRequest,
    response: core.ChangeConfigurationResponse,
  },
  ClearCache: { request: core.ClearCacheRequest, response: core.ClearCacheResponse },
  DataTransfer: { request: core.DataTransferRequest, response: core.DataTransferResponse },
  GetConfiguration: {
    request: core.GetConfigurationRequest,
    response: core.GetConfigurationResponse,
  },
  RemoteStartTransaction: {
    request: core.RemoteStartTransactionRequest,
    response: core.RemoteStartTransactionResponse,
  },
  RemoteStopTransaction: {
    request: core.RemoteStopTransactionRequest,
    response: core.RemoteStopTransactionResponse,
  },
  Reset: { request: core.ResetRequest, response: core.ResetResponse },
  UnlockConnector: {
    request: core.UnlockConnectorRequest,
    response: core.UnlockConnectorResponse,
  },
  // Firmware Management
  GetDiagnostics: { request: fw.GetDiagnosticsRequest, response: fw.GetDiagnosticsResponse },
  UpdateFirmware: { request: fw.UpdateFirmwareRequest, response: fw.UpdateFirmwareResponse },
  // Local Auth List Management
  GetLocalListVersion: {
    request: lal.GetLocalListVersionRequest,
    response: lal.GetLocalListVersionResponse,
  },
  SendLocalList: { request: lal.SendLocalListRequest, response: lal.SendLocalListResponse },
  // Reservation
  CancelReservation: {
    request: res.CancelReservationRequest,
    response: res.CancelReservationResponse,
  },
  ReserveNow: { request: res.ReserveNowRequest, response: res.ReserveNowResponse },
  // Remote Trigger
  TriggerMessage: { request: rt.TriggerMessageRequest, response: rt.TriggerMessageResponse },
  // Smart Charging
  SetChargingProfile: {
    request: sc.SetChargingProfileRequest,
    response: sc.SetChargingProfileResponse,
  },
  ClearChargingProfile: {
    request: sc.ClearChargingProfileRequest,
    response: sc.ClearChargingProfileResponse,
  },
  GetCompositeSchedule: {
    request: sc.GetCompositeScheduleRequest,
    response: sc.GetCompositeScheduleResponse,
  },
} as const;

/** Schema map of Charge Point initiated actions. */
export type ChargePointToCentralSystem = typeof ChargePointToCentralSystem;
/** Schema map of Central System initiated actions. */
export type CentralSystemToChargePoint = typeof CentralSystemToChargePoint;

/** Name of an action initiated by the Charge Point. */
export type ChargePointAction = ActionName<ChargePointToCentralSystem>;
/** Name of an action initiated by the Central System. */
export type CentralSystemAction = ActionName<CentralSystemToChargePoint>;
/** Any of the 28 OCPP 1.6 actions (DataTransfer exists in both directions). */
export type Action = ChargePointAction | CentralSystemAction;

/** Request payload of a Charge Point initiated action, e.g. `ChargePointRequest<'Authorize'>`. */
export type ChargePointRequest<A extends ChargePointAction> = RequestOf<
  ChargePointToCentralSystem,
  A
>;
/** Response payload of a Charge Point initiated action. */
export type ChargePointResponse<A extends ChargePointAction> = ResponseOf<
  ChargePointToCentralSystem,
  A
>;
/** Request payload of a Central System initiated action. */
export type CentralSystemRequest<A extends CentralSystemAction> = RequestOf<
  CentralSystemToChargePoint,
  A
>;
/** Response payload of a Central System initiated action. */
export type CentralSystemResponse<A extends CentralSystemAction> = ResponseOf<
  CentralSystemToChargePoint,
  A
>;

/**
 * The six OCPP 1.6 feature profiles, spelled as in the `SupportedFeatureProfiles` configuration
 * key.
 */
export const FEATURE_PROFILES = [
  'Core',
  'FirmwareManagement',
  'LocalAuthListManagement',
  'Reservation',
  'SmartCharging',
  'RemoteTrigger',
] as const;

/** An OCPP 1.6 feature profile. */
export type FeatureProfile = (typeof FEATURE_PROFILES)[number];

/** The feature profile each action belongs to. */
export const ACTION_PROFILES: Readonly<Record<Action, FeatureProfile>> = {
  Authorize: 'Core',
  BootNotification: 'Core',
  ChangeAvailability: 'Core',
  ChangeConfiguration: 'Core',
  ClearCache: 'Core',
  DataTransfer: 'Core',
  GetConfiguration: 'Core',
  Heartbeat: 'Core',
  MeterValues: 'Core',
  RemoteStartTransaction: 'Core',
  RemoteStopTransaction: 'Core',
  Reset: 'Core',
  StartTransaction: 'Core',
  StatusNotification: 'Core',
  StopTransaction: 'Core',
  UnlockConnector: 'Core',
  DiagnosticsStatusNotification: 'FirmwareManagement',
  FirmwareStatusNotification: 'FirmwareManagement',
  GetDiagnostics: 'FirmwareManagement',
  UpdateFirmware: 'FirmwareManagement',
  GetLocalListVersion: 'LocalAuthListManagement',
  SendLocalList: 'LocalAuthListManagement',
  CancelReservation: 'Reservation',
  ReserveNow: 'Reservation',
  ClearChargingProfile: 'SmartCharging',
  GetCompositeSchedule: 'SmartCharging',
  SetChargingProfile: 'SmartCharging',
  TriggerMessage: 'RemoteTrigger',
};

/** Transaction-related actions (see {@link isTransactionAction}). */
export type TransactionAction = 'StartTransaction' | 'StopTransaction' | 'MeterValues';

const TRANSACTION_ACTIONS: ReadonlySet<string> = new Set<TransactionAction>([
  'StartTransaction',
  'StopTransaction',
  'MeterValues',
]);

/**
 * Whether `action` is transaction-related. OCPP 1.6 requires a Charge Point to deliver these
 * reliably and in order, even across connection loss.
 */
export function isTransactionAction(action: string): action is TransactionAction {
  return TRANSACTION_ACTIONS.has(action);
}
