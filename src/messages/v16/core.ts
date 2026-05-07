/**
 * Core profile PDUs (plus TriggerMessage from the Remote Trigger profile), authored from the
 * OCPP 1.6 specification. Every object forbids undeclared properties, like the official schemas.
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
import { CiString, DateTime, NonNegativeInteger, StringEnum, strict } from './primitives.js';

const EmptyObject = () => Type.Object({}, strict);

// ---------------------------------------------------------------------------------------------
// Initiated by the Charge Point
// ---------------------------------------------------------------------------------------------

export const AuthorizeRequest = Type.Object({ idTag: IdToken }, strict);
export type AuthorizeRequest = Static<typeof AuthorizeRequest>;
export const AuthorizeResponse = Type.Object({ idTagInfo: IdTagInfo }, strict);
export type AuthorizeResponse = Static<typeof AuthorizeResponse>;

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
export type BootNotificationRequest = Static<typeof BootNotificationRequest>;

export const RegistrationStatus = StringEnum(['Accepted', 'Pending', 'Rejected']);
export type RegistrationStatus = Static<typeof RegistrationStatus>;

export const BootNotificationResponse = Type.Object(
  {
    status: RegistrationStatus,
    currentTime: DateTime(),
    interval: NonNegativeInteger('Heartbeat interval (Accepted) or retry interval, in seconds'),
  },
  strict,
);
export type BootNotificationResponse = Static<typeof BootNotificationResponse>;

export const DataTransferRequest = Type.Object(
  {
    vendorId: CiString(255),
    messageId: Type.Optional(CiString(50)),
    data: Type.Optional(Type.String()),
  },
  strict,
);
export type DataTransferRequest = Static<typeof DataTransferRequest>;

export const DataTransferStatus = StringEnum([
  'Accepted',
  'Rejected',
  'UnknownMessageId',
  'UnknownVendorId',
]);
export type DataTransferStatus = Static<typeof DataTransferStatus>;

export const DataTransferResponse = Type.Object(
  { status: DataTransferStatus, data: Type.Optional(Type.String()) },
  strict,
);
export type DataTransferResponse = Static<typeof DataTransferResponse>;

export const HeartbeatRequest = EmptyObject();
export type HeartbeatRequest = Record<string, never>;
export const HeartbeatResponse = Type.Object({ currentTime: DateTime() }, strict);
export type HeartbeatResponse = Static<typeof HeartbeatResponse>;

export const MeterValuesRequest = Type.Object(
  {
    connectorId: ConnectorIdOrStation,
    transactionId: Type.Optional(Type.Integer()),
    meterValue: Type.Array(MeterValue, { minItems: 1 }),
  },
  strict,
);
export type MeterValuesRequest = Static<typeof MeterValuesRequest>;
export const MeterValuesResponse = EmptyObject();
export type MeterValuesResponse = Record<string, never>;

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
export type StartTransactionRequest = Static<typeof StartTransactionRequest>;
export const StartTransactionResponse = Type.Object(
  { idTagInfo: IdTagInfo, transactionId: Type.Integer() },
  strict,
);
export type StartTransactionResponse = Static<typeof StartTransactionResponse>;

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
export type StatusNotificationRequest = Static<typeof StatusNotificationRequest>;
export const StatusNotificationResponse = EmptyObject();
export type StatusNotificationResponse = Record<string, never>;

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
export type StopTransactionRequest = Static<typeof StopTransactionRequest>;
export const StopTransactionResponse = Type.Object({ idTagInfo: Type.Optional(IdTagInfo) }, strict);
export type StopTransactionResponse = Static<typeof StopTransactionResponse>;

// ---------------------------------------------------------------------------------------------
// Initiated by the Central System
// ---------------------------------------------------------------------------------------------

export const AvailabilityType = StringEnum(['Inoperative', 'Operative']);
export type AvailabilityType = Static<typeof AvailabilityType>;

export const ChangeAvailabilityRequest = Type.Object(
  { connectorId: ConnectorIdOrStation, type: AvailabilityType },
  strict,
);
export type ChangeAvailabilityRequest = Static<typeof ChangeAvailabilityRequest>;

export const AvailabilityStatus = StringEnum(['Accepted', 'Rejected', 'Scheduled']);
export type AvailabilityStatus = Static<typeof AvailabilityStatus>;
export const ChangeAvailabilityResponse = Type.Object({ status: AvailabilityStatus }, strict);
export type ChangeAvailabilityResponse = Static<typeof ChangeAvailabilityResponse>;

export const ChangeConfigurationRequest = Type.Object(
  { key: CiString(50), value: CiString(500) },
  strict,
);
export type ChangeConfigurationRequest = Static<typeof ChangeConfigurationRequest>;

export const ConfigurationStatus = StringEnum([
  'Accepted',
  'Rejected',
  'RebootRequired',
  'NotSupported',
]);
export type ConfigurationStatus = Static<typeof ConfigurationStatus>;
export const ChangeConfigurationResponse = Type.Object({ status: ConfigurationStatus }, strict);
export type ChangeConfigurationResponse = Static<typeof ChangeConfigurationResponse>;

export const ClearCacheRequest = EmptyObject();
export type ClearCacheRequest = Record<string, never>;
export const ClearCacheStatus = StringEnum(['Accepted', 'Rejected']);
export type ClearCacheStatus = Static<typeof ClearCacheStatus>;
export const ClearCacheResponse = Type.Object({ status: ClearCacheStatus }, strict);
export type ClearCacheResponse = Static<typeof ClearCacheResponse>;

export const GetConfigurationRequest = Type.Object(
  { key: Type.Optional(Type.Array(CiString(50))) },
  strict,
);
export type GetConfigurationRequest = Static<typeof GetConfigurationRequest>;
export const GetConfigurationResponse = Type.Object(
  {
    configurationKey: Type.Optional(Type.Array(KeyValue)),
    unknownKey: Type.Optional(Type.Array(CiString(50))),
  },
  strict,
);
export type GetConfigurationResponse = Static<typeof GetConfigurationResponse>;

export const RemoteStartStopStatus = StringEnum(['Accepted', 'Rejected']);
export type RemoteStartStopStatus = Static<typeof RemoteStartStopStatus>;

export const RemoteStartTransactionRequest = Type.Object(
  {
    connectorId: Type.Optional(ConnectorId),
    idTag: IdToken,
    chargingProfile: Type.Optional(ChargingProfile),
  },
  strict,
);
export type RemoteStartTransactionRequest = Static<typeof RemoteStartTransactionRequest>;
export const RemoteStartTransactionResponse = Type.Object(
  { status: RemoteStartStopStatus },
  strict,
);
export type RemoteStartTransactionResponse = Static<typeof RemoteStartTransactionResponse>;

export const RemoteStopTransactionRequest = Type.Object({ transactionId: Type.Integer() }, strict);
export type RemoteStopTransactionRequest = Static<typeof RemoteStopTransactionRequest>;
export const RemoteStopTransactionResponse = Type.Object({ status: RemoteStartStopStatus }, strict);
export type RemoteStopTransactionResponse = Static<typeof RemoteStopTransactionResponse>;

export const ResetType = StringEnum(['Hard', 'Soft']);
export type ResetType = Static<typeof ResetType>;
export const ResetRequest = Type.Object({ type: ResetType }, strict);
export type ResetRequest = Static<typeof ResetRequest>;
export const ResetStatus = StringEnum(['Accepted', 'Rejected']);
export type ResetStatus = Static<typeof ResetStatus>;
export const ResetResponse = Type.Object({ status: ResetStatus }, strict);
export type ResetResponse = Static<typeof ResetResponse>;

export const UnlockConnectorRequest = Type.Object({ connectorId: ConnectorId }, strict);
export type UnlockConnectorRequest = Static<typeof UnlockConnectorRequest>;
export const UnlockStatus = StringEnum(['Unlocked', 'UnlockFailed', 'NotSupported']);
export type UnlockStatus = Static<typeof UnlockStatus>;
export const UnlockConnectorResponse = Type.Object({ status: UnlockStatus }, strict);
export type UnlockConnectorResponse = Static<typeof UnlockConnectorResponse>;

export const MessageTrigger = StringEnum([
  'BootNotification',
  'DiagnosticsStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'MeterValues',
  'StatusNotification',
]);
export type MessageTrigger = Static<typeof MessageTrigger>;

export const TriggerMessageRequest = Type.Object(
  { requestedMessage: MessageTrigger, connectorId: Type.Optional(ConnectorId) },
  strict,
);
export type TriggerMessageRequest = Static<typeof TriggerMessageRequest>;
export const TriggerMessageStatus = StringEnum(['Accepted', 'Rejected', 'NotImplemented']);
export type TriggerMessageStatus = Static<typeof TriggerMessageStatus>;
export const TriggerMessageResponse = Type.Object({ status: TriggerMessageStatus }, strict);
export type TriggerMessageResponse = Static<typeof TriggerMessageResponse>;
