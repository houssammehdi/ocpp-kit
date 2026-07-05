import { RpcError } from '../rpc/errors.js';
import type { CentralSystem, CentralSystemEvents } from '../server/central-system.js';

/** Severity of a {@link LogEntry}. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** What a {@link LogEntry} reports. */
export type LogEvent =
  'connect' | 'disconnect' | 'rejected' | 'call' | 'callCompleted' | 'badMessage' | 'frame';

/** One structured log record; absent fields do not apply to the event. */
export interface LogEntry {
  /** ISO 8601 time the event was observed. */
  readonly time: string;
  readonly level: LogLevel;
  readonly event: LogEvent;
  /** Charge point identity. */
  readonly identity?: string;
  readonly remoteAddress?: string;
  readonly action?: string;
  readonly messageId?: string;
  readonly durationMs?: number;
  /** Error code (CALLERROR, parse failure) or WebSocket close code. */
  readonly code?: string | number;
  /** Why a connection was refused or closed, or what went wrong. */
  readonly reason?: string;
  /** Frame direction, for `frame` entries. */
  readonly direction?: 'in' | 'out';
  /** The raw frame, for `frame` entries. */
  readonly frame?: string;
}

/** Receives structured log entries. */
export type Logger = (entry: LogEntry) => void;

/** Options of {@link attachLogger}. */
export interface AttachLoggerOptions {
  /** Also log every raw frame at level `debug`. Default: false. */
  readonly frames?: boolean;
}

/**
 * Turn a Central System's events into structured log entries: connections (`info`), refused
 * connections and bad frames (`warn`), answered CALLs in both directions (`debug`, `warn` for a
 * CALLERROR or timeout, `error` when a handler threw), and optionally every raw frame.
 *
 * ```ts
 * attachLogger(cs, (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));
 * ```
 *
 * @returns a function that detaches the logger.
 */
export function attachLogger(
  cs: CentralSystem,
  logger: Logger,
  options: AttachLoggerOptions = {},
): () => void {
  const time = (): string => new Date().toISOString();
  const onConnect: CentralSystemEvents['connect'] = (connection) => {
    logger({
      time: time(),
      level: 'info',
      event: 'connect',
      identity: connection.identity,
      ...(connection.remoteAddress === undefined
        ? {}
        : { remoteAddress: connection.remoteAddress }),
    });
  };
  const onDisconnect: CentralSystemEvents['disconnect'] = (connection, code, reason) => {
    logger({
      time: time(),
      level: 'info',
      event: 'disconnect',
      identity: connection.identity,
      code,
      ...(reason ? { reason } : {}),
    });
  };
  const onRejected: CentralSystemEvents['rejected'] = (info) => {
    logger({
      time: time(),
      level: 'warn',
      event: 'rejected',
      ...(info.identity === undefined ? {} : { identity: info.identity }),
      ...(info.remoteAddress === undefined ? {} : { remoteAddress: info.remoteAddress }),
      reason: info.detail === undefined ? info.reason : `${info.reason}: ${info.detail}`,
    });
  };
  const onCall: CentralSystemEvents['call'] = (event) => {
    const { error } = event;
    logger({
      time: time(),
      level: event.cause !== undefined ? 'error' : error ? 'warn' : 'debug',
      event: 'call',
      identity: event.connection.identity,
      action: event.action,
      messageId: event.messageId,
      durationMs: event.durationMs,
      ...(error
        ? {
            code: error.code,
            reason:
              event.cause instanceof Error
                ? `${error.message}: ${event.cause.message}`
                : error.message,
          }
        : {}),
    });
  };
  const onCallCompleted: CentralSystemEvents['callCompleted'] = (event) => {
    const { error } = event;
    logger({
      time: time(),
      level: error ? 'warn' : 'debug',
      event: 'callCompleted',
      identity: event.connection.identity,
      action: event.action,
      messageId: event.messageId,
      durationMs: event.durationMs,
      ...(error
        ? { code: error instanceof RpcError ? error.code : error.name, reason: error.message }
        : {}),
    });
  };
  const onBadMessage: CentralSystemEvents['badMessage'] = (connection, raw, error) => {
    logger({
      time: time(),
      level: 'warn',
      event: 'badMessage',
      identity: connection.identity,
      code: error.code,
      reason: error.message,
      frame: raw,
    });
  };
  const onMessage: CentralSystemEvents['message'] = (connection, direction, raw) => {
    logger({
      time: time(),
      level: 'debug',
      event: 'frame',
      identity: connection.identity,
      direction,
      frame: raw,
    });
  };
  cs.on('connect', onConnect);
  cs.on('disconnect', onDisconnect);
  cs.on('rejected', onRejected);
  cs.on('call', onCall);
  cs.on('callCompleted', onCallCompleted);
  cs.on('badMessage', onBadMessage);
  if (options.frames) cs.on('message', onMessage);
  return () => {
    cs.off('connect', onConnect);
    cs.off('disconnect', onDisconnect);
    cs.off('rejected', onRejected);
    cs.off('call', onCall);
    cs.off('callCompleted', onCallCompleted);
    cs.off('badMessage', onBadMessage);
    cs.off('message', onMessage);
  };
}

/** A {@link Logger} that writes one JSON document per line, e.g. to `process.stdout`. */
export function jsonLines(stream: { write(chunk: string): unknown }): Logger {
  return (entry) => {
    stream.write(`${JSON.stringify(entry)}\n`);
  };
}
