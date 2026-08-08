/**
 * Helpers shared by the check suites of every OCPP version: outcomes, evidence lines, sending a
 * typed request and classifying the answer, registration of the probe, and service checks.
 */
import type { TSchema } from '@sinclair/typebox';
import { DATE_TIME_PATTERN, URI_PATTERN } from '../../messages/v16/primitives.js';
import { MessageType, type JsonObject } from '../../rpc/frames.js';
import type { OcppProtocol } from '../../rpc/protocol.js';
import { collectIssues, type ActionSchemaMap } from '../../rpc/validation.js';
import type { ProbeConnection } from '../probe.js';
import type { CheckContext, CheckOutcome } from '../types.js';

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

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Current time in the RFC 3339 form OCPP uses. */
export function now(): string {
  return new Date().toISOString();
}

/**
 * What became of one request sent to the Central System.
 *
 * @typeParam A - the action
 * @typeParam R - the response payload type
 */
export type Exchange<A extends string = string, R = JsonObject> = (
  | { readonly kind: 'result'; readonly payload: R; readonly rttMs: number }
  | { readonly kind: 'invalid'; readonly issues: readonly string[]; readonly rttMs: number }
  | { readonly kind: 'error'; readonly code: string; readonly description: string }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'closed'; readonly code: number | undefined; readonly reason: string }
) & {
  readonly action: A;
  /** The frames exchanged, for check details. */
  readonly evidence: readonly string[];
};

/**
 * Send a request of `catalogue` and classify the answer, validating CALLRESULTs against the
 * response schema.
 */
export async function sendCall<R>(
  connection: ProbeConnection,
  catalogue: ActionSchemaMap,
  action: string,
  payload: JsonObject,
  timeoutMs: number,
): Promise<Exchange<string, R>> {
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
  const schema = catalogue[action];
  const issues = schema ? describeIssues(schema.response, frame.payload) : [];
  if (issues.length > 0) return { kind: 'invalid', issues, rttMs: result.rttMs, action, evidence };
  return { kind: 'result', payload: frame.payload as R, rttMs: result.rttMs, action, evidence };
}

/** One-line description of an unsuccessful exchange. */
export function describe(exchange: Exchange<string, unknown>, responseSuffix = '.conf'): string {
  switch (exchange.kind) {
    case 'result':
      return `${exchange.action} answered in ${exchange.rttMs.toFixed(1)} ms`;
    case 'invalid':
      return `${exchange.action}${responseSuffix} is invalid: ${exchange.issues.slice(0, 3).join('; ')}${
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

/**
 * What the version-generic checks need to know about a protocol version: its definition, how
 * the probe registers, and the spelling of a response in messages (`.conf` in 1.6,
 * `Response` in 2.0.1).
 */
export interface SuiteKit {
  readonly protocol: OcppProtocol;
  /** Prefix of the keys this suite keeps in the run's state. */
  readonly key: string;
  /** Appended to an action name to name its response, e.g. `.conf`. */
  readonly responseSuffix: string;
  /** The BootNotification request the probe sends. */
  readonly bootRequest: () => JsonObject;
}

/** The first BootNotification answer, kept for the checks that inspect it. */
export interface BootRecord<
  R = { readonly status: string; readonly interval: number; readonly currentTime: string },
> {
  readonly payload: R;
  /** Wall-clock time (ms since the epoch) when the answer arrived. */
  readonly receivedAt: number;
}

/** State key of the first BootNotification answer of a suite. */
export function bootKey(kit: SuiteKit): string {
  return `${kit.key}.boot`;
}

function registeredConnections(kit: SuiteKit, context: CheckContext): WeakSet<ProbeConnection> {
  const key = `${kit.key}.registered`;
  let set = context.state.get(key) as WeakSet<ProbeConnection> | undefined;
  if (!set) {
    set = new WeakSet();
    context.state.set(key, set);
  }
  return set;
}

/**
 * Send BootNotification on `connection`. An `Accepted` answer registers the connection; any other
 * outcome is remembered, so later checks report it instead of booting again.
 */
export async function bootWith(
  kit: SuiteKit,
  connection: ProbeConnection,
  context: CheckContext,
): Promise<
  Exchange<
    string,
    { readonly status: string; readonly interval: number; readonly currentTime: string }
  >
> {
  const exchange = await sendCall<{
    readonly status: string;
    readonly interval: number;
    readonly currentTime: string;
  }>(
    connection,
    kit.protocol.fromChargePoint,
    'BootNotification',
    kit.bootRequest(),
    context.options.timeoutMs,
  );
  const failureKey = `${kit.key}.registrationFailure`;
  if (exchange.kind === 'result') {
    if (!context.state.has(bootKey(kit))) {
      const record: BootRecord = { payload: exchange.payload, receivedAt: Date.now() };
      context.state.set(bootKey(kit), record);
    }
    if (exchange.payload.status === 'Accepted') {
      registeredConnections(kit, context).add(connection);
      return exchange;
    }
    context.state.set(
      failureKey,
      `the Central System answered BootNotification with ${exchange.payload.status}; make it accept ${context.options.identity} and run again`,
    );
  } else {
    context.state.set(failureKey, `registration failed: ${describe(exchange, kit.responseSuffix)}`);
  }
  return exchange;
}

/**
 * The shared connection, registered with an accepted BootNotification (sent once per connection).
 * Throws when the Central System does not accept the probe, which makes the check an `error`.
 */
export async function registeredWith(
  kit: SuiteKit,
  context: CheckContext,
): Promise<ProbeConnection> {
  const failureKey = `${kit.key}.registrationFailure`;
  const failure = context.state.get(failureKey);
  if (typeof failure === 'string') throw new Error(failure);
  const connection = await context.session();
  if (registeredConnections(kit, context).has(connection)) return connection;
  const exchange = await bootWith(kit, connection, context);
  if (exchange.kind === 'result' && exchange.payload.status === 'Accepted') return connection;
  throw new Error(String(context.state.get(failureKey)));
}

/**
 * Whether the Central System still serves `connection`: `undefined` when a Heartbeat is answered
 * (with a valid response, or with any answer when `anyAnswer` is set), otherwise what went wrong.
 */
export async function serviceProblemWith(
  kit: SuiteKit,
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
  const heartbeat = await sendCall(
    connection,
    kit.protocol.fromChargePoint,
    'Heartbeat',
    {},
    context.options.timeoutMs,
  );
  if (heartbeat.kind === 'result') return undefined;
  if (anyAnswer && (heartbeat.kind === 'error' || heartbeat.kind === 'invalid')) return undefined;
  return {
    problem:
      heartbeat.kind === 'closed'
        ? describe(heartbeat, kit.responseSuffix)
        : `it stopped serving: ${describe(heartbeat, kit.responseSuffix)}`,
    evidence: heartbeat.evidence,
  };
}
