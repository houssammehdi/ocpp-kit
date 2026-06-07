/**
 * Core profile PDUs, written by hand from the OCPP 1.6 specification. Every object forbids
 * undeclared properties, like the official JSON schemas.
 */
import { Type, type Static } from '@sinclair/typebox';
import {
  ChargePointErrorCode,
  ChargePointStatus,
  ChargingProfile,
  ConnectorId,
  ConnectorIdOrStation,
  IdTagInfo,
  IdToken,
  KeyValue,
  MeterValue,
  StopReason,
} from './datatypes.js';
import {
  CiString,
  DateTime,
  EmptyObject,
  NonNegativeInteger,
  StringEnum,
  strict,
} from './primitives.js';

// ---------------------------------------------------------------------------------------------
// Initiated by the Charge Point
// ---------------------------------------------------------------------------------------------

/** Authorize.req: ask whether an idTag may charge. */
export const AuthorizeRequest = Type.Object({ idTag: IdToken }, strict);
/** Authorize.req payload. */
export type AuthorizeRequest = Static<typeof AuthorizeRequest>;
/** Authorize.conf: the authorization result. */
export const AuthorizeResponse = Type.Object({ idTagInfo: IdTagInfo }, strict);
/** Authorize.conf payload. */
export type AuthorizeResponse = Static<typeof AuthorizeResponse>;

/** BootNotification.req: sent after every (re)boot, before any other request. */
export const BootNotificationRequest = Type.Object(
  {
    chargePointVendor: CiString(20),
    chargePointModel: CiString(20),
    chargePointSerialNumber: Type.Optional(CiString(25)),
    chargeBoxSerialNumber: Type.Optional(CiString(25)),
    firmwareVersion: Type.Optional(CiString(50)),
    iccid: Type.Optional(CiString(20)),
    imsi: Type.Optional(CiString(20)),
    meterType: Type.Optional(CiString(25)),
    meterSerialNumber: Type.Optional(CiString(25)),
  },
  strict,
);
/** BootNotification.req payload. */
export type BootNotificationRequest = Static<typeof BootNotificationRequest>;

/** Registration outcome of a BootNotification. */
export const RegistrationStatus = StringEnum(['Accepted', 'Pending', 'Rejected']);
/** Registration outcome of a BootNotification. */
export type RegistrationStatus = Static<typeof RegistrationStatus>;

/**
 * BootNotification.conf. When Accepted, `interval` is the heartbeat interval; otherwise it is the
 * minimum wait before the next BootNotification (0: the charge point chooses).
 */
export const BootNotificationResponse = Type.Object(
  {
    status: RegistrationStatus,
    currentTime: DateTime(),
    interval: NonNegativeInteger('Heartbeat interval (Accepted) or retry interval, in seconds'),
  },
  strict,
);
/** BootNotification.conf payload. */
export type BootNotificationResponse = Static<typeof BootNotificationResponse>;

/** DataTransfer.req: vendor-specific data, in either direction. */
export const DataTransferRequest = Type.Object(
  {
    vendorId: CiString(255),
    messageId: Type.Optional(CiString(50)),
    data: Type.Optional(Type.String()),
  },
  strict,
);
/** DataTransfer.req payload. */
export type DataTransferRequest = Static<typeof DataTransferRequest>;

/** Outcome of a DataTransfer. Unknown vendors must be answered with `UnknownVendorId`. */
export const DataTransferStatus = StringEnum([
  'Accepted',
  'Rejected',
  'UnknownMessageId',
  'UnknownVendorId',
]);
/** Outcome of a DataTransfer. */
export type DataTransferStatus = Static<typeof DataTransferStatus>;

/** DataTransfer.conf. */
export const DataTransferResponse = Type.Object(
  { status: DataTransferStatus, data: Type.Optional(Type.String()) },
  strict,
);
/** DataTransfer.conf payload. */
export type DataTransferResponse = Static<typeof DataTransferResponse>;

/** Heartbeat.req (no fields). */
export const HeartbeatRequest = EmptyObject();
/** Heartbeat.req payload. */
export type HeartbeatRequest = Record<string, never>;
/** Heartbeat.conf: the Central System's clock, for time synchronisation. */
export const HeartbeatResponse = Type.Object({ currentTime: DateTime() }, strict);
/** Heartbeat.conf payload. */
export type HeartbeatResponse = Static<typeof HeartbeatResponse>;

/** MeterValues.req: sampled or clock-aligned readings of a connector (0 = main meter). */
export const MeterValuesRequest = Type.Object(
  {
    connectorId: ConnectorIdOrStation,
    transactionId: Type.Optional(Type.Integer()),
    meterValue: Type.Array(MeterValue, { minItems: 1 }),
  },
  strict,
);
/** MeterValues.req payload. */
export type MeterValuesRequest = Static<typeof MeterValuesRequest>;
/** MeterValues.conf (no fields). */
export const MeterValuesResponse = EmptyObject();
/** MeterValues.conf payload. */
export type MeterValuesResponse = Record<string, never>;

/** StartTransaction.req. `reservationId` is set when the transaction uses a reservation. */
export const StartTransactionRequest = Type.Object(
  {
    connectorId: ConnectorId,
    idTag: IdToken,
    meterStart: Type.Integer({ description: 'Energy register in Wh at the start' }),
    reservationId: Type.Optional(Type.Integer()),
    timestamp: DateTime(),
  },
  strict,
);
/** StartTransaction.req payload. */
export type StartTransactionRequest = Static<typeof StartTransactionRequest>;
/** StartTransaction.conf: the transaction id assigned by the Central System. */
export const StartTransactionResponse = Type.Object(
  { idTagInfo: IdTagInfo, transactionId: Type.Integer() },
  strict,
);
/** StartTransaction.conf payload. */
export type StartTransactionResponse = Static<typeof StartTransactionResponse>;

/** StatusNotification.req: a connector (or, for 0, the charge point) changed status. */
export const StatusNotificationRequest = Type.Object(
  {
    connectorId: ConnectorIdOrStation,
    errorCode: ChargePointErrorCode,
    info: Type.Optional(CiString(50)),
    status: ChargePointStatus,
    timestamp: Type.Optional(DateTime()),
    vendorId: Type.Optional(CiString(255)),
    vendorErrorCode: Type.Optional(CiString(50)),
  },
  strict,
);
/** StatusNotification.req payload. */
export type StatusNotificationRequest = Static<typeof StatusNotificationRequest>;
/** StatusNotification.conf (no fields). */
export const StatusNotificationResponse = EmptyObject();
/** StatusNotification.conf payload. */
export type StatusNotificationResponse = Record<string, never>;

/** StopTransaction.req, optionally with the transaction's meter data for billing. */
export const StopTransactionRequest = Type.Object(
  {
    idTag: Type.Optional(IdToken),
    meterStop: Type.Integer({ description: 'Energy register in Wh at the end' }),
    timestamp: DateTime(),
    transactionId: Type.Integer(),
    reason: Type.Optional(StopReason),
    transactionData: Type.Optional(Type.Array(MeterValue)),
  },
  strict,
);
/** StopTransaction.req payload. */
export type StopTransactionRequest = Static<typeof StopTransactionRequest>;
/** StopTransaction.conf: optional authorization info for the idTag that stopped. */
export const StopTransactionResponse = Type.Object({ idTagInfo: Type.Optional(IdTagInfo) }, strict);
/** StopTransaction.conf payload. */
export type StopTransactionResponse = Static<typeof StopTransactionResponse>;

// ---------------------------------------------------------------------------------------------
// Initiated by the Central System
// ---------------------------------------------------------------------------------------------

/** Requested availability of a connector or of the charge point. */
export const AvailabilityType = StringEnum(['Inoperative', 'Operative']);
/** Requested availability. */
export type AvailabilityType = Static<typeof AvailabilityType>;

/** ChangeAvailability.req (connector 0: the charge point and all connectors). */
export const ChangeAvailabilityRequest = Type.Object(
  { connectorId: ConnectorIdOrStation, type: AvailabilityType },
  strict,
);
/** ChangeAvailability.req payload. */
export type ChangeAvailabilityRequest = Static<typeof ChangeAvailabilityRequest>;

/** Outcome of ChangeAvailability; `Scheduled` means after the running transaction. */
export const AvailabilityStatus = StringEnum(['Accepted', 'Rejected', 'Scheduled']);
/** Outcome of ChangeAvailability. */
export type AvailabilityStatus = Static<typeof AvailabilityStatus>;
/** ChangeAvailability.conf. */
export const ChangeAvailabilityResponse = Type.Object({ status: AvailabilityStatus }, strict);
/** ChangeAvailability.conf payload. */
export type ChangeAvailabilityResponse = Static<typeof ChangeAvailabilityResponse>;

/** ChangeConfiguration.req. */
export const ChangeConfigurationRequest = Type.Object(
  { key: CiString(50), value: CiString(500) },
  strict,
);
/** ChangeConfiguration.req payload. */
export type ChangeConfigurationRequest = Static<typeof ChangeConfigurationRequest>;

/** Outcome of ChangeConfiguration. */
export const ConfigurationStatus = StringEnum([
  'Accepted',
  'Rejected',
  'RebootRequired',
  'NotSupported',
]);
/** Outcome of ChangeConfiguration. */
export type ConfigurationStatus = Static<typeof ConfigurationStatus>;
/** ChangeConfiguration.conf. */
export const ChangeConfigurationResponse = Type.Object({ status: ConfigurationStatus }, strict);
/** ChangeConfiguration.conf payload. */
export type ChangeConfigurationResponse = Static<typeof ChangeConfigurationResponse>;

/** ClearCache.req (no fields): empty the Authorization Cache. */
export const ClearCacheRequest = EmptyObject();
/** ClearCache.req payload. */
export type ClearCacheRequest = Record<string, never>;
/** Outcome of ClearCache. */
export const ClearCacheStatus = StringEnum(['Accepted', 'Rejected']);
/** Outcome of ClearCache. */
export type ClearCacheStatus = Static<typeof ClearCacheStatus>;
/** ClearCache.conf. */
export const ClearCacheResponse = Type.Object({ status: ClearCacheStatus }, strict);
/** ClearCache.conf payload. */
export type ClearCacheResponse = Static<typeof ClearCacheResponse>;

/** GetConfiguration.req; without keys, every key is requested. */
export const GetConfigurationRequest = Type.Object(
  { key: Type.Optional(Type.Array(CiString(50))) },
  strict,
);
/** GetConfiguration.req payload. */
export type GetConfigurationRequest = Static<typeof GetConfigurationRequest>;
/** GetConfiguration.conf: known keys with values, and the requested keys that are unknown. */
export const GetConfigurationResponse = Type.Object(
  {
    configurationKey: Type.Optional(Type.Array(KeyValue)),
    unknownKey: Type.Optional(Type.Array(CiString(50))),
  },
  strict,
);
/** GetConfiguration.conf payload. */
export type GetConfigurationResponse = Static<typeof GetConfigurationResponse>;

/** Outcome of RemoteStartTransaction and RemoteStopTransaction. */
export const RemoteStartStopStatus = StringEnum(['Accepted', 'Rejected']);
/** Outcome of RemoteStartTransaction and RemoteStopTransaction. */
export type RemoteStartStopStatus = Static<typeof RemoteStartStopStatus>;

/** RemoteStartTransaction.req, optionally with a TxProfile for the new transaction. */
export const RemoteStartTransactionRequest = Type.Object(
  {
    connectorId: Type.Optional(ConnectorId),
    idTag: IdToken,
    chargingProfile: Type.Optional(ChargingProfile),
  },
  strict,
);
/** RemoteStartTransaction.req payload. */
export type RemoteStartTransactionRequest = Static<typeof RemoteStartTransactionRequest>;
/** RemoteStartTransaction.conf. */
export const RemoteStartTransactionResponse = Type.Object(
  { status: RemoteStartStopStatus },
  strict,
);
/** RemoteStartTransaction.conf payload. */
export type RemoteStartTransactionResponse = Static<typeof RemoteStartTransactionResponse>;

/** RemoteStopTransaction.req. */
export const RemoteStopTransactionRequest = Type.Object({ transactionId: Type.Integer() }, strict);
/** RemoteStopTransaction.req payload. */
export type RemoteStopTransactionRequest = Static<typeof RemoteStopTransactionRequest>;
/** RemoteStopTransaction.conf. */
export const RemoteStopTransactionResponse = Type.Object({ status: RemoteStartStopStatus }, strict);
/** RemoteStopTransaction.conf payload. */
export type RemoteStopTransactionResponse = Static<typeof RemoteStopTransactionResponse>;

/** Kind of reset: Soft stops transactions gracefully first, Hard restarts right away. */
export const ResetType = StringEnum(['Hard', 'Soft']);
/** Kind of reset. */
export type ResetType = Static<typeof ResetType>;
/** Reset.req. */
export const ResetRequest = Type.Object({ type: ResetType }, strict);
/** Reset.req payload. */
export type ResetRequest = Static<typeof ResetRequest>;
/** Outcome of Reset. */
export const ResetStatus = StringEnum(['Accepted', 'Rejected']);
/** Outcome of Reset. */
export type ResetStatus = Static<typeof ResetStatus>;
/** Reset.conf. */
export const ResetResponse = Type.Object({ status: ResetStatus }, strict);
/** Reset.conf payload. */
export type ResetResponse = Static<typeof ResetResponse>;

/** UnlockConnector.req. */
export const UnlockConnectorRequest = Type.Object({ connectorId: ConnectorId }, strict);
/** UnlockConnector.req payload. */
export type UnlockConnectorRequest = Static<typeof UnlockConnectorRequest>;
/** Outcome of UnlockConnector. */
export const UnlockStatus = StringEnum(['Unlocked', 'UnlockFailed', 'NotSupported']);
/** Outcome of UnlockConnector. */
export type UnlockStatus = Static<typeof UnlockStatus>;
/** UnlockConnector.conf. */
export const UnlockConnectorResponse = Type.Object({ status: UnlockStatus }, strict);
/** UnlockConnector.conf payload. */
export type UnlockConnectorResponse = Static<typeof UnlockConnectorResponse>;
