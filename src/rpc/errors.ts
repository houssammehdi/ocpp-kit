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
  /** The OCPP error code. */
  readonly code: OcppErrorCode;
  /** Free-form details, sent as the `errorDetails` object of a CALLERROR frame. */
  readonly details: ErrorDetails;
  /** True when the error was received from the remote peer. */
  readonly remote: boolean;

  constructor(
    code: OcppErrorCode,
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
