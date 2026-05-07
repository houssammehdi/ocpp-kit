import type { ActionName, RequestOf, ResponseOf } from '../../rpc/validation.js';
import * as core from './core.js';
import * as sc from './smart-charging.js';

/**
 * Actions a Charge Point sends to the Central System, with their request/response schemas.
 * This object drives both runtime validation and the static types of `call()` and `handle()`.
 */
export const ChargePointToCentralSystem = {
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
} as const;

/** Actions the Central System sends to a Charge Point. */
export const CentralSystemToChargePoint = {
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
  TriggerMessage: { request: core.TriggerMessageRequest, response: core.TriggerMessageResponse },
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
 * Transaction-related messages. OCPP 1.6 requires a Charge Point to deliver these reliably and
 * in order, even across connection loss.
 */
export const TRANSACTION_ACTIONS: ReadonlySet<ChargePointAction> = new Set([
  'StartTransaction',
  'StopTransaction',
  'MeterValues',
]);
