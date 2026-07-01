/** Helpers shared by the OCPP 1.6-J checks. */
import type { TSchema } from '@sinclair/typebox';
import {
  ChargePointToCentralSystem,
  DATE_TIME_PATTERN,
  URI_PATTERN,
  type ChargePointAction,
  type ChargePointRequest,
  type ChargePointResponse,
} from '../../messages/index.js';
import { MessageType } from '../../rpc/frames.js';
import { collectIssues } from '../../rpc/validation.js';
import { VERSION } from '../../version.js';
import type { ProbeConnection } from '../probe.js';
import type { CheckContext, CheckOutcome } from '../types.js';

/** The subprotocol of OCPP 1.6-J. */
export const OCPP16 = 'ocpp1.6';

/** A passing outcome. */
export const pass = (message: string, details: readonly string[] = []): CheckOutcome => ({
  status: 'pass',
  message,
  details,
});
/** A failing outcome. */
export const fail = (message: string, details: readonly string[] = []): CheckOutcome => ({
  status: 'fail',
  message,
  details,
});
/** A check that does not apply. */
export const skip = (message: string): CheckOutcome => ({ status: 'skip', message });

/** How long to watch for straggling answers after a Heartbeat that followed a probe frame. */
export function grace(context: CheckContext, rttMs = 0): number {
  return Math.min(context.options.timeoutMs, Math.max(250, 3 * rttMs));
}

/** Frames quoted in check details are cut to this many characters. */
const MAX_QUOTE = 300;

/** Cut `text` to at most `max` characters. */
export function clip(text: string, max = MAX_QUOTE): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/** Evidence line for a frame the probe sent. */
export function sentLine(raw: string): string {
  return `> ${clip(raw)}`;
}

/** Evidence line for a frame the probe received. */
export function receivedLine(raw: string): string {
  return `< ${clip(raw)}`;
}

/** The value at a JSON pointer such as `/idTagInfo/status`. */
function valueAt(value: unknown, pointer: string): unknown {
  let current = value;
  for (const token of pointer.split('/').slice(1)) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[token.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return current;
}

const PATTERN_NAMES: readonly (readonly [string, string])[] = [
  [DATE_TIME_PATTERN, 'an RFC 3339 date-time with a time zone offset'],
  [URI_PATTERN, 'an absolute URI'],
];

/** Schema violations of `value` in words, naming well-known patterns instead of quoting them. */
export function describeIssues(schema: TSchema, value: unknown): string[] {
  return collectIssues(schema, value).map(({ path, message }) => {
    const pattern = PATTERN_NAMES.find(([source]) => message.includes(source));
    const found = valueAt(value, path);
    const text = pattern
      ? `is not ${pattern[1]}: ${found === undefined ? 'nothing' : clip(JSON.stringify(found), 60)}`
      : message;
    return `${path} ${text}`;
  });
}

/** What became of one request sent to the Central System. */
export type Exchange<A extends ChargePointAction> = (
  | {
      readonly kind: 'result';
      readonly payload: ChargePointResponse<A>;
      readonly rttMs: number;
    }
  | { readonly kind: 'invalid'; readonly issues: readonly string[]; readonly rttMs: number }
  | { readonly kind: 'error'; readonly code: string; readonly description: string }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'closed'; readonly code: number | undefined; readonly reason: string }
) & {
  readonly action: A;
  /** The frames exchanged, for check details. */
  readonly evidence: readonly string[];
};

/** The error code of a raw CALLERROR exactly as sent (the parser maps unknown codes). */
export function rawErrorCode(raw: string | undefined): string {
  try {
    const value: unknown = JSON.parse(raw ?? '');
    if (Array.isArray(value) && typeof value[2] === 'string') return value[2];
  } catch {
    // Not JSON: no code.
  }
  return '?';
}

/** Send a typed request and classify the answer, validating CALLRESULTs against the schema. */
export async function send<A extends ChargePointAction>(
  connection: ProbeConnection,
  action: A,
  payload: ChargePointRequest<A>,
  timeoutMs: number,
): Promise<Exchange<A>> {
  const result = await connection.call(action, payload, timeoutMs);
  const evidence = [
    sentLine(JSON.stringify([MessageType.Call, result.messageId, action, payload])),
    ...(result.raw === undefined ? [] : [receivedLine(result.raw)]),
  ];
  const { frame } = result;
  if (frame === undefined) {
    if (connection.isOpen) return { kind: 'timeout', timeoutMs, action, evidence };
    const info = connection.closeInfo;
    return { kind: 'closed', code: info?.code, reason: info?.reason ?? '', action, evidence };
  }
  if (frame.type === MessageType.CallError) {
    return {
      kind: 'error',
      code: rawErrorCode(result.raw),
      description: frame.errorDescription,
      action,
      evidence,
    };
  }
  const issues = describeIssues(ChargePointToCentralSystem[action].response, frame.payload);
  if (issues.length > 0) {
    return { kind: 'invalid', issues, rttMs: result.rttMs, action, evidence };
  }
  return {
    kind: 'result',
    payload: frame.payload,
    rttMs: result.rttMs,
    action,
    evidence,
  };
}

/** One-line description of an unsuccessful exchange. */
export function describe(exchange: Exchange<ChargePointAction>): string {
  switch (exchange.kind) {
    case 'result':
      return `${exchange.action} answered in ${exchange.rttMs.toFixed(1)} ms`;
    case 'invalid':
      return `${exchange.action}.conf is invalid: ${exchange.issues.slice(0, 3).join('; ')}${
        exchange.issues.length > 3 ? `; and ${exchange.issues.length - 3} more` : ''
      }`;
    case 'error':
      return `${exchange.action} was answered with CALLERROR ${exchange.code}${
        exchange.description ? ` (${clip(exchange.description, 120)})` : ''
      }`;
    case 'timeout':
      return `${exchange.action} got no answer within ${exchange.timeoutMs} ms`;
    case 'closed':
      return `the connection closed before ${exchange.action} was answered (code ${
        exchange.code ?? '?'
      }${exchange.reason ? `: ${clip(exchange.reason, 120)}` : ''})`;
  }
}

/** A failed outcome describing an unsuccessful exchange. */
export function failed(exchange: Exchange<ChargePointAction>, prefix = ''): CheckOutcome {
  return { status: 'fail', message: `${prefix}${describe(exchange)}`, details: exchange.evidence };
}

/** Current time in the RFC 3339 form OCPP uses. */
export function now(): string {
  return new Date().toISOString();
}

/** The BootNotification the probe sends. */
export function bootRequest(): ChargePointRequest<'BootNotification'> {
  return {
    chargePointVendor: 'ocpp-kit',
    chargePointModel: 'conformance-probe',
    firmwareVersion: VERSION,
  };
}

const REGISTERED = 'v16.registered';
const REGISTRATION_FAILURE = 'v16.registrationFailure';
/** State key of the answer to the first BootNotification (see {@link BootRecord}). */
export const BOOT = 'v16.boot';

/** The first BootNotification answer, kept for the checks that inspect it. */
export interface BootRecord {
  readonly payload: ChargePointResponse<'BootNotification'>;
  /** Wall-clock time (ms since the epoch) when the answer arrived. */
  readonly receivedAt: number;
}

function registeredConnections(context: CheckContext): WeakSet<ProbeConnection> {
  let set = context.state.get(REGISTERED) as WeakSet<ProbeConnection> | undefined;
  if (!set) {
    set = new WeakSet();
    context.state.set(REGISTERED, set);
  }
  return set;
}

/**
 * Send BootNotification on `connection`. An `Accepted` answer registers the connection; any other
 * outcome is remembered, so later checks report it instead of booting again.
 */
export async function boot(
  connection: ProbeConnection,
  context: CheckContext,
): Promise<Exchange<'BootNotification'>> {
  const exchange = await send(
    connection,
    'BootNotification',
    bootRequest(),
    context.options.timeoutMs,
  );
  if (exchange.kind === 'result') {
    if (!context.state.has(BOOT)) {
      const record: BootRecord = { payload: exchange.payload, receivedAt: Date.now() };
      context.state.set(BOOT, record);
    }
    if (exchange.payload.status === 'Accepted') {
      registeredConnections(context).add(connection);
      return exchange;
    }
    context.state.set(
      REGISTRATION_FAILURE,
      `the Central System answered BootNotification with ${exchange.payload.status}; make it accept ${context.options.identity} and run again`,
    );
  } else {
    context.state.set(REGISTRATION_FAILURE, `registration failed: ${describe(exchange)}`);
  }
  return exchange;
}

/**
 * The shared connection, registered with an accepted BootNotification (sent once per connection).
 * Throws when the Central System does not accept the probe, which makes the check an `error`.
 */
export async function registered(context: CheckContext): Promise<ProbeConnection> {
  const failure = context.state.get(REGISTRATION_FAILURE);
  if (typeof failure === 'string') throw new Error(failure);
  const connection = await context.session();
  if (registeredConnections(context).has(connection)) return connection;
  const exchange = await boot(connection, context);
  if (exchange.kind === 'result' && exchange.payload.status === 'Accepted') return connection;
  throw new Error(String(context.state.get(REGISTRATION_FAILURE)));
}

/**
 * Whether the Central System still serves `connection`: `undefined` when a Heartbeat is answered
 * (with a valid Heartbeat.conf, or with any answer when `anyAnswer` is set), otherwise what went
 * wrong.
 */
export async function serviceProblem(
  connection: ProbeConnection,
  context: CheckContext,
  anyAnswer = false,
): Promise<{ readonly problem: string; readonly evidence: readonly string[] } | undefined> {
  if (!connection.isOpen) {
    const info = connection.closeInfo;
    return {
      problem: `the Central System closed the connection (code ${info?.code ?? '?'}${
        info?.reason ? `: ${clip(info.reason, 120)}` : ''
      })`,
      evidence: [],
    };
  }
  const heartbeat = await send(connection, 'Heartbeat', {}, context.options.timeoutMs);
  if (heartbeat.kind === 'result') return undefined;
  if (anyAnswer && (heartbeat.kind === 'error' || heartbeat.kind === 'invalid')) return undefined;
  return {
    problem:
      heartbeat.kind === 'closed'
        ? describe(heartbeat)
        : `it stopped serving: ${describe(heartbeat)}`,
    evidence: heartbeat.evidence,
  };
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
