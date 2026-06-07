/** Remote Trigger profile PDUs, written by hand from the OCPP 1.6 specification. */
import { Type, type Static } from '@sinclair/typebox';
import { ConnectorIdOrStation } from './datatypes.js';
import { StringEnum, strict } from './primitives.js';

/** Messages a Central System can ask a charge point to send with TriggerMessage. */
export const MessageTrigger = StringEnum([
  'BootNotification',
  'DiagnosticsStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'MeterValues',
  'StatusNotification',
]);
/** Messages a Central System can ask a charge point to send with TriggerMessage. */
export type MessageTrigger = Static<typeof MessageTrigger>;

/**
 * TriggerMessage.req. The specification's field table says `connectorId > 0`, but its prose
 * (a StatusNotification trigger for connector 0 asks for the status of the charge point itself)
 * and the official JSON schema allow 0, so 0 is accepted here. Without `connectorId`, a
 * connector-related message is requested for every connector.
 */
export const TriggerMessageRequest = Type.Object(
  { requestedMessage: MessageTrigger, connectorId: Type.Optional(ConnectorIdOrStation) },
  strict,
);
/** TriggerMessage.req payload. */
export type TriggerMessageRequest = Static<typeof TriggerMessageRequest>;
/** Outcome of TriggerMessage; the requested message follows the response. */
export const TriggerMessageStatus = StringEnum(['Accepted', 'Rejected', 'NotImplemented']);
/** Outcome of TriggerMessage. */
export type TriggerMessageStatus = Static<typeof TriggerMessageStatus>;
/** TriggerMessage.conf. */
export const TriggerMessageResponse = Type.Object({ status: TriggerMessageStatus }, strict);
/** TriggerMessage.conf payload. */
export type TriggerMessageResponse = Static<typeof TriggerMessageResponse>;
