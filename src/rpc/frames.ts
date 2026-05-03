import { isOcppErrorCode, RpcError, type ErrorDetails, type OcppErrorCode } from './errors.js';

/** OCPP-J message type ids (the first element of every frame). */
export const MessageType = {
  Call: 2,
  CallResult: 3,
  CallError: 4,
} as const;

/** Numeric message type id. */
export type MessageTypeId = (typeof MessageType)[keyof typeof MessageType];

/** OCPP-J limits message ids to 36 characters (enough for a UUID). */
export const MAX_MESSAGE_ID_LENGTH = 36;

/** A JSON object payload. OCPP-J payloads are always objects, never arrays or primitives. */
export type JsonObject = Record<string, unknown>;

/** `[2, "<messageId>", "<action>", {<payload>}]` */
export interface CallFrame {
  readonly type: typeof MessageType.Call;
  readonly messageId: string;
  readonly action: string;
  readonly payload: JsonObject;
}

/** `[3, "<messageId>", {<payload>}]` */
export interface CallResultFrame {
  readonly type: typeof MessageType.CallResult;
  readonly messageId: string;
  readonly payload: JsonObject;
}

/** `[4, "<messageId>", "<errorCode>", "<errorDescription>", {<errorDetails>}]` */
export interface CallErrorFrame {
  readonly type: typeof MessageType.CallError;
  readonly messageId: string;
  readonly errorCode: OcppErrorCode;
  readonly errorDescription: string;
  readonly errorDetails: ErrorDetails;
}

/** Any OCPP-J frame. */
export type Frame = CallFrame | CallResultFrame | CallErrorFrame;

/** Successful parse. */
export interface ParseSuccess {
  readonly ok: true;
  readonly frame: Frame;
}

/**
 * Failed parse. `messageId` and `messageType` are filled in whenever they could be recovered, so
 * the caller can decide whether a CALLERROR reply is possible (only for CALL frames with an id).
 */
export interface ParseFailure {
  readonly ok: false;
  readonly error: RpcError;
  readonly messageId?: string;
  readonly messageType?: MessageTypeId;
}

/** Result of {@link parseFrame}. Parsing never throws. */
export type ParseResult = ParseSuccess | ParseFailure;

/** Expected array length for each message type. */
const FRAME_LENGTH: Readonly<Record<MessageTypeId, number>> = {
  [MessageType.Call]: 4,
  [MessageType.CallResult]: 3,
  [MessageType.CallError]: 5,
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessageTypeId(value: unknown): value is MessageTypeId {
  return (
    value === MessageType.Call ||
    value === MessageType.CallResult ||
    value === MessageType.CallError
  );
}

function fail(
  code: OcppErrorCode,
  description: string,
  context: { messageId?: string | undefined; messageType?: MessageTypeId | undefined } = {},
): ParseFailure {
  return {
    ok: false,
    error: new RpcError(code, description),
    ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
    ...(context.messageType === undefined ? {} : { messageType: context.messageType }),
  };
}

/**
 * Parse and structurally validate a raw OCPP-J text frame.
 *
 * Error mapping (the specification defines the codes but not how framing faults map onto them,
 * so ocpp-kit uses this deterministic table):
 *
 * | Fault                                                     | Code                 |
 * | --------------------------------------------------------- | -------------------- |
 * | not JSON, not an array, id not a string, bad field types  | `FormationViolation` |
 * | message id empty or longer than 36 characters             | `FormationViolation` |
 * | more elements than the message type allows                | `FormationViolation` |
 * | unknown message type id                                   | `ProtocolError`      |
 * | fewer elements than the message type requires             | `ProtocolError`      |
 */
export function parseFrame(raw: string): ParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return fail('FormationViolation', 'Message is not valid JSON');
  }
  if (!Array.isArray(decoded)) {
    return fail('FormationViolation', 'Message must be a JSON array');
  }
  const frame: unknown[] = decoded;
  const [typeId, messageId] = frame;
  if (typeof messageId !== 'string') {
    if (frame.length < 2) return fail('ProtocolError', 'Message is incomplete');
    return fail('FormationViolation', 'Message id must be a string');
  }
  if (!isMessageTypeId(typeId)) {
    return fail('ProtocolError', `Unknown message type id: ${JSON.stringify(typeId)}`, {
      messageId,
    });
  }
  const context = { messageId, messageType: typeId };
  if (messageId.length === 0 || messageId.length > MAX_MESSAGE_ID_LENGTH) {
    return fail(
      'FormationViolation',
      `Message id must be 1-${MAX_MESSAGE_ID_LENGTH} characters long`,
      context,
    );
  }
  const expectedLength = FRAME_LENGTH[typeId];
  if (frame.length < expectedLength) {
    return fail(
      'ProtocolError',
      `Message is incomplete: expected ${expectedLength} elements, got ${frame.length}`,
      context,
    );
  }
  if (frame.length > expectedLength) {
    return fail(
      'FormationViolation',
      `Message has too many elements: expected ${expectedLength}, got ${frame.length}`,
      context,
    );
  }

  switch (typeId) {
    case MessageType.Call: {
      const [, , action, payload] = frame;
      if (typeof action !== 'string' || action.length === 0) {
        return fail('FormationViolation', 'Action must be a non-empty string', context);
      }
      if (!isJsonObject(payload)) {
        return fail('FormationViolation', 'Payload must be a JSON object', context);
      }
      return { ok: true, frame: { type: typeId, messageId, action, payload } };
    }
    case MessageType.CallResult: {
      const [, , payload] = frame;
      if (!isJsonObject(payload)) {
        return fail('FormationViolation', 'Payload must be a JSON object', context);
      }
      return { ok: true, frame: { type: typeId, messageId, payload } };
    }
    case MessageType.CallError: {
      const [, , errorCode, errorDescription, errorDetails] = frame;
      if (typeof errorCode !== 'string') {
        return fail('FormationViolation', 'Error code must be a string', context);
      }
      if (typeof errorDescription !== 'string') {
        return fail('FormationViolation', 'Error description must be a string', context);
      }
      if (!isJsonObject(errorDetails)) {
        return fail('FormationViolation', 'Error details must be a JSON object', context);
      }
      // Unknown codes from non-compliant peers are surfaced as GenericError, keeping the original.
      const known = isOcppErrorCode(errorCode);
      return {
        ok: true,
        frame: {
          type: typeId,
          messageId,
          errorCode: known ? errorCode : 'GenericError',
          errorDescription,
          errorDetails: known ? errorDetails : { ...errorDetails, originalErrorCode: errorCode },
        },
      };
    }
  }
}

/** Serialize a frame to its OCPP-J wire representation. */
export function serializeFrame(frame: Frame): string {
  switch (frame.type) {
    case MessageType.Call:
      return JSON.stringify([frame.type, frame.messageId, frame.action, frame.payload]);
    case MessageType.CallResult:
      return JSON.stringify([frame.type, frame.messageId, frame.payload]);
    case MessageType.CallError:
      return JSON.stringify([
        frame.type,
        frame.messageId,
        frame.errorCode,
        frame.errorDescription,
        frame.errorDetails,
      ]);
  }
}

/** Build a CALLERROR frame from an {@link RpcError}. */
export function callErrorFrame(messageId: string, error: RpcError): CallErrorFrame {
  return {
    type: MessageType.CallError,
    messageId,
    errorCode: error.code,
    errorDescription: error.message === error.code ? '' : error.message,
    errorDetails: error.details,
  };
}
