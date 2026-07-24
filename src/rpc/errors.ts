/**
 * Error codes defined by OCPP-J 1.6 for CALLERROR frames (section 4.2.3 of the JSON specification).
 *
 * Note that `OccurenceConstraintViolation` intentionally keeps the misspelling used by the
 * specification: interoperating implementations compare these codes as literal strings.
 */
export const OcppErrorCodes = [
  'NotImplemented',
  'NotSupported',
  'InternalError',
  'ProtocolError',
  'SecurityError',
  'FormationViolation',
  'PropertyConstraintViolation',
  'OccurenceConstraintViolation',
  'TypeConstraintViolation',
  'GenericError',
] as const;

/** One of the ten CALLERROR codes allowed by OCPP-J 1.6. */
export type OcppErrorCode = (typeof OcppErrorCodes)[number];

/** Returns true when `value` is a valid OCPP-J 1.6 error code. */
export function isOcppErrorCode(value: unknown): value is OcppErrorCode {
  return typeof value === 'string' && (OcppErrorCodes as readonly string[]).includes(value);
}

/**
 * Error codes defined by OCPP-J 2.0.1 (Part 4, "RPC Framework Error Codes"). Compared with 1.6,
 * `FormationViolation` became `FormatViolation`, `OccurrenceConstraintViolation` is spelled
 * correctly, and `MessageTypeNotSupported` and `RpcFrameworkError` are new.
 */
export const Ocpp201ErrorCodes = [
  'FormatViolation',
  'GenericError',
  'InternalError',
  'MessageTypeNotSupported',
  'NotImplemented',
  'NotSupported',
  'OccurrenceConstraintViolation',
  'PropertyConstraintViolation',
  'ProtocolError',
  'RpcFrameworkError',
  'SecurityError',
  'TypeConstraintViolation',
] as const;

/** One of the twelve CALLERROR codes allowed by OCPP-J 2.0.1. */
export type Ocpp201ErrorCode = (typeof Ocpp201ErrorCodes)[number];

/** Returns true when `value` is a valid OCPP-J 2.0.1 error code. */
export function isOcpp201ErrorCode(value: unknown): value is Ocpp201ErrorCode {
  return typeof value === 'string' && (Ocpp201ErrorCodes as readonly string[]).includes(value);
}

/** A CALLERROR code of any supported OCPP version. */
export type RpcErrorCode = OcppErrorCode | Ocpp201ErrorCode;

/**
 * The error codes of one OCPP version, by the role the RPC layer uses them in. Framing and
 * validation faults are reported with the code of the matching role, so the same RPC layer
 * speaks the error vocabulary of whichever version a connection negotiated.
 */
export interface ErrorCodeSet {
  /** Every code the version defines. A received code outside this list becomes `generic`. */
  readonly codes: readonly RpcErrorCode[];
  /** The frame is not a valid RPC message: not JSON, no readable message id, wrong elements. */
  readonly rpcFramework: RpcErrorCode;
  /** The frame has fewer elements than its message type requires. */
  readonly incompleteFrame: RpcErrorCode;
  /** The payload is syntactically wrong: not an object, or a property the PDU does not define. */
  readonly format: RpcErrorCode;
  /** A required field is missing, or an array has too few or too many elements. */
  readonly occurrence: RpcErrorCode;
  /** A field has the wrong JSON type. */
  readonly type: RpcErrorCode;
  /** A field has the right type but an invalid value (length, range, enumeration, pattern). */
  readonly property: RpcErrorCode;
  /** The action is unknown. */
  readonly notImplemented: RpcErrorCode;
  /** The action is known but not supported. */
  readonly notSupported: RpcErrorCode;
  /** The receiver failed to process the request. */
  readonly internal: RpcErrorCode;
  /** A security issue prevented processing, e.g. no accepted BootNotification yet. */
  readonly security: RpcErrorCode;
  /** Anything else. */
  readonly generic: RpcErrorCode;
}

/**
 * How ocpp-kit reports faults on an OCPP 1.6 connection. OCPP-J 1.6 has no dedicated code for a
 * broken frame, so `FormationViolation` ("not conform the PDU structure") covers it and a frame
 * with too few elements is a `ProtocolError` ("Payload for Action is incomplete").
 */
export const OCPP16_ERROR_CODES: ErrorCodeSet = {
  codes: OcppErrorCodes,
  rpcFramework: 'FormationViolation',
  incompleteFrame: 'ProtocolError',
  format: 'FormationViolation',
  occurrence: 'OccurenceConstraintViolation',
  type: 'TypeConstraintViolation',
  property: 'PropertyConstraintViolation',
  notImplemented: 'NotImplemented',
  notSupported: 'NotSupported',
  internal: 'InternalError',
  security: 'SecurityError',
  generic: 'GenericError',
};

/**
 * How ocpp-kit reports faults on an OCPP 2.0.1 connection: `RpcFrameworkError` for frames that
 * are not a valid RPC request, `FormatViolation` for syntactically wrong payloads.
 */
export const OCPP201_ERROR_CODES: ErrorCodeSet = {
  codes: Ocpp201ErrorCodes,
  rpcFramework: 'RpcFrameworkError',
  incompleteFrame: 'RpcFrameworkError',
  format: 'FormatViolation',
  occurrence: 'OccurrenceConstraintViolation',
  type: 'TypeConstraintViolation',
  property: 'PropertyConstraintViolation',
  notImplemented: 'NotImplemented',
  notSupported: 'NotSupported',
  internal: 'InternalError',
  security: 'SecurityError',
  generic: 'GenericError',
};

/** Codes with the same meaning under a different name in the other version. */
const EQUIVALENT: Readonly<Partial<Record<RpcErrorCode, readonly RpcErrorCode[]>>> = {
  FormationViolation: ['FormatViolation'],
  FormatViolation: ['FormationViolation'],
  OccurenceConstraintViolation: ['OccurrenceConstraintViolation'],
  OccurrenceConstraintViolation: ['OccurenceConstraintViolation'],
  RpcFrameworkError: ['FormationViolation'],
};

/**
 * Translate `code` into the vocabulary of `set`: unchanged when the set defines it, its
 * equivalent when there is one (`FormationViolation` and `FormatViolation`, the two spellings of
 * `Occur(r)enceConstraintViolation`), otherwise `undefined`.
 */
export function translateErrorCode(code: string, set: ErrorCodeSet): RpcErrorCode | undefined {
  const known = set.codes as readonly string[];
  if (known.includes(code)) return code as RpcErrorCode;
  return EQUIVALENT[code as RpcErrorCode]?.find((candidate) => known.includes(candidate));
}

/** Structured, JSON-serialisable error details carried in a CALLERROR frame. */
export type ErrorDetails = Record<string, unknown>;

/** Base class of every error thrown by ocpp-kit, handy for `instanceof` filtering. */
export class OcppKitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * An OCPP-level failure that maps to a CALLERROR frame.
 *
 * Handlers may throw it to reply with a specific error code; `call()` rejects with it when the
 * peer answers with CALLERROR (`remote === true`) or when local validation fails before a frame
 * is ever sent (`remote === false`).
 */
export class RpcError extends OcppKitError {
  /** The OCPP error code (of the version spoken on the connection). */
  readonly code: RpcErrorCode;
  /** Free-form details, sent as the `errorDetails` object of a CALLERROR frame. */
  readonly details: ErrorDetails;
  /** True when the error was received from the remote peer. */
  readonly remote: boolean;

  constructor(
    code: RpcErrorCode,
    message = '',
    details: ErrorDetails = {},
    options: { remote?: boolean; cause?: unknown } = {},
  ) {
    super(message || code, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = details;
    this.remote = options.remote ?? false;
  }
}

/** A CALL did not receive a CALLRESULT/CALLERROR within its timeout. */
export class CallTimeoutError extends OcppKitError {
  constructor(
    readonly action: string,
    readonly messageId: string,
    readonly timeoutMs: number,
  ) {
    super(`${action} (${messageId}) timed out after ${timeoutMs} ms`);
  }
}

/** The underlying connection closed while a CALL was queued or awaiting its response. */
export class ConnectionClosedError extends OcppKitError {
  constructor(
    readonly code?: number,
    readonly reason?: string,
  ) {
    super(
      `Connection closed${code === undefined ? '' : ` (${code}${reason ? `: ${reason}` : ''})`}`,
    );
  }
}

/** A CALL was aborted through its `AbortSignal` before a response arrived. */
export class CallAbortedError extends OcppKitError {
  constructor(readonly action: string) {
    super(`${action} was aborted`);
  }
}
