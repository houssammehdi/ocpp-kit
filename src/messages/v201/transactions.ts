/**
 * OCPP 2.0.1 Authorization (C), Local Authorization List (D), Transactions (E), Remote Control
 * (F), Reservation (H) and Metering (J) messages, written by hand from the specification.
 */
import { Type, type Static } from '@sinclair/typebox';
import {
  ChargingProfile,
  ConnectorKind,
  Evse,
  GenericStatus,
  IdToken,
  IdTokenInfo,
  MessageContent,
  MeterValue,
  OcspRequestData,
  StatusInfo,
} from './datatypes.js';
import { DateTime, EmptyPdu, Obj, Str, StringEnum } from './primitives.js';

// ---------------------------------------------------------------------------------------------
// Authorization (C)
// ---------------------------------------------------------------------------------------------

/** AuthorizeRequest. `certificate` and the hash data are for ISO 15118 Plug & Charge. */
export const AuthorizeRequest = Obj({
  idToken: IdToken,
  certificate: Type.Optional(Str(5500)),
  iso15118CertificateHashData: Type.Optional(
    Type.Array(OcspRequestData, { minItems: 1, maxItems: 4 }),
  ),
});
/** AuthorizeRequest payload. */
export type AuthorizeRequest = Static<typeof AuthorizeRequest>;

/** `AuthorizeCertificateStatusEnumType`. */
export const AuthorizeCertificateStatus = StringEnum([
  'Accepted',
  'SignatureError',
  'CertificateExpired',
  'CertificateRevoked',
  'NoCertificateAvailable',
  'CertChainError',
  'ContractCancelled',
]);
/** Outcome of the certificate check of an Authorize. */
export type AuthorizeCertificateStatus = Static<typeof AuthorizeCertificateStatus>;

/** AuthorizeResponse. */
export const AuthorizeResponse = Obj({
  idTokenInfo: IdTokenInfo,
  certificateStatus: Type.Optional(AuthorizeCertificateStatus),
});
/** AuthorizeResponse payload. */
export type AuthorizeResponse = Static<typeof AuthorizeResponse>;

/** ClearCacheRequest (no fields). */
export const ClearCacheRequest = EmptyPdu();
/** ClearCacheRequest payload. */
export type ClearCacheRequest = Static<typeof ClearCacheRequest>;
/** ClearCacheResponse. */
export const ClearCacheResponse = Obj({
  status: GenericStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** ClearCacheResponse payload. */
export type ClearCacheResponse = Static<typeof ClearCacheResponse>;

// ---------------------------------------------------------------------------------------------
// Local Authorization List (D)
// ---------------------------------------------------------------------------------------------

/** `AuthorizationData`: one entry of the local list; without `idTokenInfo` it is removed. */
export const AuthorizationData = Obj({
  idToken: IdToken,
  idTokenInfo: Type.Optional(IdTokenInfo),
});
/** One entry of the local list. */
export type AuthorizationData = Static<typeof AuthorizationData>;

/** `UpdateEnumType`. */
export const UpdateKind = StringEnum(['Differential', 'Full']);
/** Kind of local list update. */
export type UpdateKind = Static<typeof UpdateKind>;

/** SendLocalListRequest. */
export const SendLocalListRequest = Obj({
  localAuthorizationList: Type.Optional(Type.Array(AuthorizationData, { minItems: 1 })),
  versionNumber: Type.Integer(),
  updateType: UpdateKind,
});
/** SendLocalListRequest payload. */
export type SendLocalListRequest = Static<typeof SendLocalListRequest>;

/** `SendLocalListStatusEnumType`. */
export const SendLocalListStatus = StringEnum(['Accepted', 'Failed', 'VersionMismatch']);
/** Outcome of SendLocalList. */
export type SendLocalListStatus = Static<typeof SendLocalListStatus>;

/** SendLocalListResponse. */
export const SendLocalListResponse = Obj({
  status: SendLocalListStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** SendLocalListResponse payload. */
export type SendLocalListResponse = Static<typeof SendLocalListResponse>;

/** GetLocalListVersionRequest (no fields). */
export const GetLocalListVersionRequest = EmptyPdu();
/** GetLocalListVersionRequest payload. */
export type GetLocalListVersionRequest = Static<typeof GetLocalListVersionRequest>;
/** GetLocalListVersionResponse. */
export const GetLocalListVersionResponse = Obj({ versionNumber: Type.Integer() });
/** GetLocalListVersionResponse payload. */
export type GetLocalListVersionResponse = Static<typeof GetLocalListVersionResponse>;

// ---------------------------------------------------------------------------------------------
// Transactions (E)
// ---------------------------------------------------------------------------------------------

/** `TransactionEventEnumType`. */
export const TransactionEventKind = StringEnum(['Ended', 'Started', 'Updated']);
/** Which part of a transaction a TransactionEvent reports. */
export type TransactionEventKind = Static<typeof TransactionEventKind>;

/** `TriggerReasonEnumType`: what caused a TransactionEvent. */
export const TriggerReason = StringEnum([
  'Authorized',
  'CablePluggedIn',
  'ChargingRateChanged',
  'ChargingStateChanged',
  'Deauthorized',
  'EnergyLimitReached',
  'EVCommunicationLost',
  'EVConnectTimeout',
  'MeterValueClock',
  'MeterValuePeriodic',
  'TimeLimitReached',
  'Trigger',
  'UnlockCommand',
  'StopAuthorized',
  'EVDeparted',
  'EVDetected',
  'RemoteStop',
  'RemoteStart',
  'AbnormalCondition',
  'SignedDataReceived',
  'ResetCommand',
]);
/** What caused a TransactionEvent. */
export type TriggerReason = Static<typeof TriggerReason>;

/** `ChargingStateEnumType`. */
export const ChargingState = StringEnum([
  'Charging',
  'EVConnected',
  'SuspendedEV',
  'SuspendedEVSE',
  'Idle',
]);
/** Charging state of a transaction. */
export type ChargingState = Static<typeof ChargingState>;

/** `ReasonEnumType`: why a transaction stopped. */
export const StoppedReason = StringEnum([
  'DeAuthorized',
  'EmergencyStop',
  'EnergyLimitReached',
  'EVDisconnected',
  'GroundFault',
  'ImmediateReset',
  'Local',
  'LocalOutOfCredit',
  'MasterPass',
  'Other',
  'OvercurrentFault',
  'PowerLoss',
  'PowerQuality',
  'Reboot',
  'Remote',
  'SOCLimitReached',
  'StoppedByEV',
  'TimeLimitReached',
  'Timeout',
]);
/** Why a transaction stopped. */
export type StoppedReason = Static<typeof StoppedReason>;

/** `TransactionType`: the transaction a TransactionEvent belongs to. */
export const TransactionInfo = Obj({
  transactionId: Str(36, 'Generated by the Charging Station, unique on the station'),
  chargingState: Type.Optional(ChargingState),
  timeSpentCharging: Type.Optional(Type.Integer()),
  stoppedReason: Type.Optional(StoppedReason),
  remoteStartId: Type.Optional(Type.Integer()),
});
/** Transaction details of a TransactionEvent. */
export type TransactionInfo = Static<typeof TransactionInfo>;

/**
 * TransactionEventRequest: Started, Updated or Ended. The transaction id is chosen by the
 * station; `seqNo` numbers the events so the CSMS can tell whether it has all of them, and
 * `offline` marks events that happened while the station was offline.
 */
export const TransactionEventRequest = Obj({
  eventType: TransactionEventKind,
  meterValue: Type.Optional(Type.Array(MeterValue, { minItems: 1 })),
  timestamp: DateTime(),
  triggerReason: TriggerReason,
  seqNo: Type.Integer(),
  offline: Type.Optional(Type.Boolean()),
  numberOfPhasesUsed: Type.Optional(Type.Integer()),
  cableMaxCurrent: Type.Optional(Type.Integer()),
  reservationId: Type.Optional(Type.Integer()),
  transactionInfo: TransactionInfo,
  evse: Type.Optional(Evse),
  idToken: Type.Optional(IdToken),
});
/** TransactionEventRequest payload. */
export type TransactionEventRequest = Static<typeof TransactionEventRequest>;

/** TransactionEventResponse. `idTokenInfo` is sent when the request carried an idToken. */
export const TransactionEventResponse = Obj({
  totalCost: Type.Optional(Type.Number()),
  chargingPriority: Type.Optional(Type.Integer()),
  idTokenInfo: Type.Optional(IdTokenInfo),
  updatedPersonalMessage: Type.Optional(MessageContent),
});
/** TransactionEventResponse payload. */
export type TransactionEventResponse = Static<typeof TransactionEventResponse>;

/** GetTransactionStatusRequest: about one transaction, or about queued messages in general. */
export const GetTransactionStatusRequest = Obj({ transactionId: Type.Optional(Str(36)) });
/** GetTransactionStatusRequest payload. */
export type GetTransactionStatusRequest = Static<typeof GetTransactionStatusRequest>;

/** GetTransactionStatusResponse. */
export const GetTransactionStatusResponse = Obj({
  ongoingIndicator: Type.Optional(Type.Boolean()),
  messagesInQueue: Type.Boolean(),
});
/** GetTransactionStatusResponse payload. */
export type GetTransactionStatusResponse = Static<typeof GetTransactionStatusResponse>;

// ---------------------------------------------------------------------------------------------
// Remote control (F)
// ---------------------------------------------------------------------------------------------

/** RequestStartTransactionRequest. `remoteStartId` comes back in the TransactionEvents. */
export const RequestStartTransactionRequest = Obj({
  evseId: Type.Optional(Type.Integer()),
  groupIdToken: Type.Optional(IdToken),
  idToken: IdToken,
  remoteStartId: Type.Integer(),
  chargingProfile: Type.Optional(ChargingProfile),
});
/** RequestStartTransactionRequest payload. */
export type RequestStartTransactionRequest = Static<typeof RequestStartTransactionRequest>;

/** `RequestStartStopStatusEnumType`. */
export const RequestStartStopStatus = StringEnum(['Accepted', 'Rejected']);
/** Outcome of a remote start or stop. */
export type RequestStartStopStatus = Static<typeof RequestStartStopStatus>;

/**
 * RequestStartTransactionResponse. `transactionId` is set when a transaction was already running
 * on the EVSE (e.g. started when the cable was plugged in).
 */
export const RequestStartTransactionResponse = Obj({
  status: RequestStartStopStatus,
  statusInfo: Type.Optional(StatusInfo),
  transactionId: Type.Optional(Str(36)),
});
/** RequestStartTransactionResponse payload. */
export type RequestStartTransactionResponse = Static<typeof RequestStartTransactionResponse>;

/** RequestStopTransactionRequest. */
export const RequestStopTransactionRequest = Obj({ transactionId: Str(36) });
/** RequestStopTransactionRequest payload. */
export type RequestStopTransactionRequest = Static<typeof RequestStopTransactionRequest>;

/** RequestStopTransactionResponse. */
export const RequestStopTransactionResponse = Obj({
  status: RequestStartStopStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** RequestStopTransactionResponse payload. */
export type RequestStopTransactionResponse = Static<typeof RequestStopTransactionResponse>;

/** `MessageTriggerEnumType`: what TriggerMessage can ask for. */
export const MessageTrigger = StringEnum([
  'BootNotification',
  'LogStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'MeterValues',
  'SignChargingStationCertificate',
  'SignV2GCertificate',
  'StatusNotification',
  'TransactionEvent',
  'SignCombinedCertificate',
  'PublishFirmwareStatusNotification',
]);
/** A message TriggerMessage can ask for. */
export type MessageTrigger = Static<typeof MessageTrigger>;

/** TriggerMessageRequest. */
export const TriggerMessageRequest = Obj({
  evse: Type.Optional(Evse),
  requestedMessage: MessageTrigger,
});
/** TriggerMessageRequest payload. */
export type TriggerMessageRequest = Static<typeof TriggerMessageRequest>;

/** `TriggerMessageStatusEnumType`. */
export const TriggerMessageStatus = StringEnum(['Accepted', 'Rejected', 'NotImplemented']);
/** Outcome of TriggerMessage. */
export type TriggerMessageStatus = Static<typeof TriggerMessageStatus>;

/** TriggerMessageResponse. */
export const TriggerMessageResponse = Obj({
  status: TriggerMessageStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** TriggerMessageResponse payload. */
export type TriggerMessageResponse = Static<typeof TriggerMessageResponse>;

/** UnlockConnectorRequest. */
export const UnlockConnectorRequest = Obj({
  evseId: Type.Integer(),
  connectorId: Type.Integer(),
});
/** UnlockConnectorRequest payload. */
export type UnlockConnectorRequest = Static<typeof UnlockConnectorRequest>;

/** `UnlockStatusEnumType`. */
export const UnlockStatus = StringEnum([
  'Unlocked',
  'UnlockFailed',
  'OngoingAuthorizedTransaction',
  'UnknownConnector',
]);
/** Outcome of UnlockConnector. */
export type UnlockStatus = Static<typeof UnlockStatus>;

/** UnlockConnectorResponse. */
export const UnlockConnectorResponse = Obj({
  status: UnlockStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** UnlockConnectorResponse payload. */
export type UnlockConnectorResponse = Static<typeof UnlockConnectorResponse>;

// ---------------------------------------------------------------------------------------------
// Reservation (H)
// ---------------------------------------------------------------------------------------------

/** ReserveNowRequest. Without `evseId` the reservation holds any EVSE. */
export const ReserveNowRequest = Obj({
  id: Type.Integer(),
  expiryDateTime: DateTime(),
  connectorType: Type.Optional(ConnectorKind),
  idToken: IdToken,
  evseId: Type.Optional(Type.Integer()),
  groupIdToken: Type.Optional(IdToken),
});
/** ReserveNowRequest payload. */
export type ReserveNowRequest = Static<typeof ReserveNowRequest>;

/** `ReserveNowStatusEnumType`. */
export const ReserveNowStatus = StringEnum([
  'Accepted',
  'Faulted',
  'Occupied',
  'Rejected',
  'Unavailable',
]);
/** Outcome of ReserveNow. */
export type ReserveNowStatus = Static<typeof ReserveNowStatus>;

/** ReserveNowResponse. */
export const ReserveNowResponse = Obj({
  status: ReserveNowStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** ReserveNowResponse payload. */
export type ReserveNowResponse = Static<typeof ReserveNowResponse>;

/** CancelReservationRequest. */
export const CancelReservationRequest = Obj({ reservationId: Type.Integer() });
/** CancelReservationRequest payload. */
export type CancelReservationRequest = Static<typeof CancelReservationRequest>;
/** CancelReservationResponse. */
export const CancelReservationResponse = Obj({
  status: GenericStatus,
  statusInfo: Type.Optional(StatusInfo),
});
/** CancelReservationResponse payload. */
export type CancelReservationResponse = Static<typeof CancelReservationResponse>;

/** `ReservationUpdateStatusEnumType`. */
export const ReservationUpdateStatus = StringEnum(['Expired', 'Removed']);
/** How a reservation ended without being used. */
export type ReservationUpdateStatus = Static<typeof ReservationUpdateStatus>;

/** ReservationStatusUpdateRequest: a reservation expired or was removed. */
export const ReservationStatusUpdateRequest = Obj({
  reservationId: Type.Integer(),
  reservationUpdateStatus: ReservationUpdateStatus,
});
/** ReservationStatusUpdateRequest payload. */
export type ReservationStatusUpdateRequest = Static<typeof ReservationStatusUpdateRequest>;
/** ReservationStatusUpdateResponse. */
export const ReservationStatusUpdateResponse = EmptyPdu();
/** ReservationStatusUpdateResponse payload. */
export type ReservationStatusUpdateResponse = Static<typeof ReservationStatusUpdateResponse>;

// ---------------------------------------------------------------------------------------------
// Metering (J)
// ---------------------------------------------------------------------------------------------

/**
 * MeterValuesRequest: values not related to a transaction (those travel in TransactionEvent).
 * `evseId` 0 is the main meter of the station.
 */
export const MeterValuesRequest = Obj({
  evseId: Type.Integer(),
  meterValue: Type.Array(MeterValue, { minItems: 1 }),
});
/** MeterValuesRequest payload. */
export type MeterValuesRequest = Static<typeof MeterValuesRequest>;
/** MeterValuesResponse. */
export const MeterValuesResponse = EmptyPdu();
/** MeterValuesResponse payload. */
export type MeterValuesResponse = Static<typeof MeterValuesResponse>;
