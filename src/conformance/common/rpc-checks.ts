/**
 * Checks of the OCPP-J RPC framework shared by every OCPP version: error handling, robustness,
 * synchronicity, the validity of the Central System's own CALLs, and latency. Each factory takes
 * the suite's kit and its specification references.
 */
import { randomUUID } from 'node:crypto';
import { MAX_MESSAGE_ID_LENGTH, MessageType, parseFrame } from '../../rpc/frames.js';
import { LatencyTracker } from '../../simulator/stats.js';
import type { ProbeConnection } from '../probe.js';
import type { Check, CheckContext, CheckOutcome } from '../types.js';
import {
  bootWith,
  clip,
  describe as describeExchange,
  describeIssues,
  fail,
  grace,
  pass,
  rawErrorCode,
  receivedLine,
  registeredWith,
  sendCall,
  sentLine,
  serviceProblemWith,
  skip,
  sleep,
  type Exchange,
  type SuiteKit,
} from './exchange.js';

/** The helpers of a kit, bound. */
function helpers(kit: SuiteKit) {
  return {
    registered: (context: CheckContext) => registeredWith(kit, context),
    serviceProblem: (connection: ProbeConnection, context: CheckContext, anyAnswer?: boolean) =>
      serviceProblemWith(kit, connection, context, anyAnswer),
    heartbeat: (connection: ProbeConnection, context: CheckContext) =>
      sendCall(
        connection,
        kit.protocol.fromChargePoint,
        'Heartbeat',
        {},
        context.options.timeoutMs,
      ),
    describe: (exchange: Exchange<string, unknown>) =>
      describeExchange(exchange, kit.responseSuffix),
  };
}

/** The message type of a raw frame, if it is a JSON array. */
function rawMessageType(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Send a frame followed by a Heartbeat, give straggling answers a moment, and report what came
 * back mentioning `id`, which CALLERRORs arrived meanwhile, and whether the Central System still
 * serves the connection.
 */
async function probeWithFrame(
  kit: SuiteKit,
  connection: ProbeConnection,
  context: CheckContext,
  raw: string,
  id: string,
): Promise<{
  readonly replies: readonly string[];
  readonly callErrors: readonly string[];
  readonly problem: string | undefined;
  readonly evidence: readonly string[];
}> {
  const { heartbeat: sendHeartbeat, serviceProblem, describe } = helpers(kit);
  const mark = connection.log.length;
  connection.send(raw);
  const heartbeat = await sendHeartbeat(connection, context);
  if (heartbeat.kind === 'result') await sleep(grace(context, heartbeat.rttMs));
  const received = connection.receivedSince(mark).map((record) => record.raw);
  const replies = received.filter((text) => text.includes(id));
  const callErrors = received.filter((text) => rawMessageType(text) === MessageType.CallError);
  const evidence = [sentLine(raw), ...[...new Set([...replies, ...callErrors])].map(receivedLine)];
  if (heartbeat.kind === 'result') return { replies, callErrors, problem: undefined, evidence };
  const problem = await serviceProblem(connection, context);
  return {
    replies,
    callErrors,
    problem: problem?.problem ?? describe(heartbeat),
    evidence: [...evidence, ...heartbeat.evidence],
  };
}

/** How the Central System answered a hand-made CALL frame. */
type RawAnswer =
  | { readonly kind: 'callerror'; readonly code: string }
  | { readonly kind: 'other'; readonly what: string };

/**
 * Send a hand-made CALL and wait for the frame answering `messageId`. Raw frames are searched,
 * because the answer may repeat an id the parser rejects (e.g. one that is too long).
 */
async function answerTo(
  connection: ProbeConnection,
  context: CheckContext,
  raw: string,
  messageId: string,
): Promise<{ readonly answer: RawAnswer; readonly evidence: readonly string[] }> {
  const mark = connection.log.length;
  connection.send(raw);
  const deadline = performance.now() + context.options.timeoutMs;
  const quoted = JSON.stringify(messageId);
  for (;;) {
    for (const record of connection.receivedSince(mark, quoted)) {
      let value: unknown;
      try {
        value = JSON.parse(record.raw);
      } catch {
        continue;
      }
      if (!Array.isArray(value) || value[1] !== messageId) continue;
      const evidence = [sentLine(raw), receivedLine(record.raw)];
      if (value[0] === MessageType.CallError) {
        return {
          answer: { kind: 'callerror', code: typeof value[2] === 'string' ? value[2] : '?' },
          evidence,
        };
      }
      return {
        answer: {
          kind: 'other',
          what:
            value[0] === MessageType.CallResult
              ? 'a CALLRESULT'
              : `a frame of type ${JSON.stringify(value[0])}`,
        },
        evidence,
      };
    }
    if (!connection.isOpen) {
      return {
        answer: { kind: 'other', what: 'no answer (the connection closed)' },
        evidence: [sentLine(raw)],
      };
    }
    if (performance.now() >= deadline) {
      return {
        answer: { kind: 'other', what: `no answer within ${context.options.timeoutMs} ms` },
        evidence: [sentLine(raw)],
      };
    }
    await sleep(20);
  }
}

const UNKNOWN_ACTION = 'OcppKitProbeUnknownAction';

/** `rpc.unknown-action`: a CALL with an unknown action gets a CALLERROR of the version. */
export function unknownActionCheck(kit: SuiteKit, spec: string): Check {
  const codes: readonly string[] = kit.protocol.errorCodes.codes;
  return {
    id: 'rpc.unknown-action',
    title: 'Answers a CALL with an unknown action with a CALLERROR',
    level: 'MUST',
    spec,
    async run(context) {
      const connection = await helpers(kit).registered(context);
      const result = await connection.call(UNKNOWN_ACTION, {}, context.options.timeoutMs);
      const evidence = [
        sentLine(JSON.stringify([MessageType.Call, result.messageId, UNKNOWN_ACTION, {}])),
        ...(result.raw === undefined ? [] : [receivedLine(result.raw)]),
      ];
      if (result.frame === undefined) {
        return fail(
          connection.isOpen
            ? `no answer within ${context.options.timeoutMs} ms`
            : `the connection closed (code ${connection.closeInfo?.code ?? '?'})`,
          evidence,
        );
      }
      if (result.frame.type === MessageType.CallResult)
        return fail('answered with a CALLRESULT', evidence);
      const code = rawErrorCode(result.raw);
      if (!codes.includes(code)) {
        return fail(
          `answered with the error code "${code}", which OCPP-J does not define`,
          evidence,
        );
      }
      context.state.set(`${kit.key}.unknownActionCode`, code);
      return pass(`CALLERROR ${code}`, evidence);
    },
  };
}

/** `rpc.unknown-action-code`: the CALLERROR for an unknown action is NotImplemented. */
export function unknownActionCodeCheck(kit: SuiteKit, spec: string): Check {
  return {
    id: 'rpc.unknown-action-code',
    title: 'Uses the NotImplemented error code for unknown actions',
    level: 'SHOULD',
    spec,
    requires: ['rpc.unknown-action'],
    run(context) {
      const code = String(context.state.get(`${kit.key}.unknownActionCode`));
      return Promise.resolve(
        code === 'NotImplemented'
          ? pass('NotImplemented')
          : fail(`${code} instead of NotImplemented`),
      );
    },
  };
}

/** A frame the Central System must answer with a CALLERROR, and the codes that fit. */
export interface MalformedCase {
  readonly label: string;
  readonly raw: (id: string) => string;
  readonly id?: string;
  readonly expected: readonly string[];
}

/** Send each case and require a CALLERROR with one of its expected codes. */
async function expectCallErrors(
  kit: SuiteKit,
  context: CheckContext,
  cases: readonly MalformedCase[],
): Promise<CheckOutcome> {
  const { registered, serviceProblem } = helpers(kit);
  const connection = await registered(context);
  const details: string[] = [];
  const problems: string[] = [];
  for (const test of cases) {
    const id = test.id ?? randomUUID();
    const { answer, evidence } = await answerTo(connection, context, test.raw(id), id);
    const ok = answer.kind === 'callerror' && test.expected.includes(answer.code);
    const got = answer.kind === 'callerror' ? `CALLERROR ${answer.code}` : answer.what;
    details.push(
      `${test.label}: ${got}${ok ? '' : ` (expected ${test.expected.join(' or ')})`}`,
      ...evidence,
    );
    if (!ok) problems.push(`${test.label}: ${got}`);
    if (!connection.isOpen) break;
  }
  const problem = await serviceProblem(connection, context);
  if (problem) problems.push(problem.problem);
  return problems.length === 0
    ? pass(`all ${cases.length} answered with a fitting CALLERROR`, details)
    : fail(problems.join('; '), details);
}

/** `rpc.invalid-payload`: schema-violating payloads get a fitting CALLERROR. */
export function invalidPayloadCheck(
  kit: SuiteKit,
  spec: string,
  cases: readonly MalformedCase[],
): Check {
  return {
    id: 'rpc.invalid-payload',
    title: 'Answers schema-violating payloads with a fitting CALLERROR',
    level: 'SHOULD',
    spec,
    run: (context) => expectCallErrors(kit, context, cases),
  };
}

/** The three structurally broken CALL frames of `rpc.malformed-frame`, with fitting codes. */
export function malformedFrameCases(expected: {
  readonly withoutPayload: readonly string[];
  readonly stringPayload: readonly string[];
  readonly longId: readonly string[];
}): MalformedCase[] {
  return [
    {
      label: 'CALL without payload',
      raw: (id) => `[2,${JSON.stringify(id)},"Heartbeat"]`,
      expected: expected.withoutPayload,
    },
    {
      label: 'CALL whose payload is a string',
      raw: (id) => `[2,${JSON.stringify(id)},"Heartbeat","payload"]`,
      expected: expected.stringPayload,
    },
    {
      label: `message id longer than ${MAX_MESSAGE_ID_LENGTH} characters`,
      id: `${randomUUID()}-x`,
      raw: (id) => `[2,${JSON.stringify(id)},"Heartbeat",{}]`,
      expected: expected.longId,
    },
  ];
}

/** `rpc.malformed-frame`: structurally invalid CALL frames get a CALLERROR. */
export function malformedFrameCheck(
  kit: SuiteKit,
  spec: string,
  cases: readonly MalformedCase[],
): Check {
  return {
    id: 'rpc.malformed-frame',
    title: 'Answers structurally invalid CALL frames with a CALLERROR',
    level: 'SHOULD',
    spec,
    run: (context) => expectCallErrors(kit, context, cases),
  };
}

/** `rpc.malformed-json`: a frame that is not JSON does not stop the service. */
export function malformedJsonCheck(kit: SuiteKit, spec: string): Check {
  return {
    id: 'rpc.malformed-json',
    title: 'Keeps serving after a frame that is not valid JSON',
    level: 'SHOULD',
    spec,
    async run(context) {
      const connection = await helpers(kit).registered(context);
      const id = randomUUID();
      const { problem, evidence, callErrors } = await probeWithFrame(
        kit,
        connection,
        context,
        `[2,"${id}","Heartbeat",{`,
        id,
      );
      if (problem) return fail(problem, evidence);
      return pass(
        callErrors.length > 0 ? 'answered with a CALLERROR and kept serving' : 'kept serving',
        evidence,
      );
    },
  };
}

/**
 * `rpc.unknown-message-type`: a frame with an unknown message type is ignored.
 *
 * @param tolerated - CALLERROR codes that also count as ignoring it (2.0.1 once defined
 *   `MessageTypeNotSupported` for this; its errata later deprecated the code)
 */
export function unknownMessageTypeCheck(
  kit: SuiteKit,
  spec: string,
  tolerated: readonly string[] = [],
): Check {
  return {
    id: 'rpc.unknown-message-type',
    title: 'Ignores frames with an unknown message type',
    level: 'MUST',
    spec,
    async run(context) {
      const connection = await helpers(kit).registered(context);
      const id = randomUUID();
      const { problem, evidence, replies } = await probeWithFrame(
        kit,
        connection,
        context,
        `[7,"${id}",{}]`,
        id,
      );
      if (problem) return fail(problem, evidence);
      const answered = replies.filter(
        (reply) =>
          !(
            rawMessageType(reply) === MessageType.CallError &&
            tolerated.includes(rawErrorCode(reply))
          ),
      );
      if (answered.length > 0)
        return fail('answered a frame of message type 7 instead of ignoring it', evidence);
      if (replies.length > 0) {
        return pass(`answered with CALLERROR ${rawErrorCode(replies[0])} and kept serving`, [
          ...evidence,
          `${tolerated.join(', ')} is tolerated here, but ignoring the frame is what the specification asks for`,
        ]);
      }
      return pass('ignored it and kept serving', evidence);
    },
  };
}

/** `rpc.unmatched-response`: a CALLRESULT or CALLERROR that answers no CALL is ignored. */
export function unmatchedResponseCheck(kit: SuiteKit, spec: string): Check {
  return {
    id: 'rpc.unmatched-response',
    title: 'Ignores a CALLRESULT or CALLERROR that answers no CALL',
    level: 'SHOULD',
    spec,
    async run(context) {
      const connection = await helpers(kit).registered(context);
      const details: string[] = [];
      for (const raw of [
        (id: string) => `[3,"${id}",{}]`,
        (id: string) => `[4,"${id}","GenericError","",{}]`,
      ]) {
        const id = randomUUID();
        const outcome = await probeWithFrame(kit, connection, context, raw(id), id);
        details.push(...outcome.evidence);
        if (outcome.problem) return fail(outcome.problem, details);
        if (outcome.replies.length > 0) return fail('answered an unmatched response', details);
      }
      return pass('ignored both and kept serving', details);
    },
  };
}

/**
 * `rpc.single-outstanding-call`: no second CALL while one is unanswered.
 *
 * @param invite - requests sent after the boot that invite the CALLs Central Systems send, e.g.
 *   a StatusNotification of an Available connector (which invites a remote start)
 */
export function singleOutstandingCallCheck(
  kit: SuiteKit,
  spec: string,
  invite: (connection: ProbeConnection, context: CheckContext) => Promise<unknown>,
): Check {
  return {
    id: 'rpc.single-outstanding-call',
    title: 'Sends no second CALL while one is unanswered',
    level: 'SHOULD',
    spec,
    async run(context) {
      const { observeMs } = context.options;
      // A fresh registration invites the CALLs Central Systems send after a boot.
      await context.endSession();
      const connection = await context.connect();
      connection.answerCalls({ delayMs: observeMs });
      const exchange = await bootWith(kit, connection, context);
      if (exchange.kind !== 'result' || exchange.payload.status !== 'Accepted') {
        throw new Error(`registration failed: ${helpers(kit).describe(exchange)}`);
      }
      await invite(connection, context);
      if (connection.serverCalls.length === 0) {
        await connection.waitFor((frame) => frame.type === MessageType.Call, observeMs);
      }
      const [first] = connection.serverCalls;
      if (first === undefined) {
        if (!connection.isOpen) throw new Error('the connection closed during the observation');
        return skip(`the Central System sent no CALL within ${observeMs} ms; nothing to observe`);
      }
      // The probe answers `first` observeMs after it arrived: watch until shortly before that.
      const remaining = first.receivedAt + observeMs - 50 - performance.now();
      if (connection.serverCalls.length === 1 && remaining > 0) {
        await connection.waitFor((frame) => frame.type === MessageType.Call, remaining);
      }
      const second = connection.serverCalls[1];
      const details = connection.serverCalls.map(
        (call) =>
          `${call.frame.action} ${call.frame.messageId} at +${(call.receivedAt - first.receivedAt).toFixed(0)} ms`,
      );
      if (second !== undefined && second.receivedAt < (first.answeredAt ?? Infinity)) {
        return fail(
          `sent ${second.frame.action} while ${first.frame.action} was unanswered`,
          details,
        );
      }
      return pass(
        `sent nothing else while ${first.frame.action} stayed unanswered for ${observeMs} ms`,
        details,
      );
    },
  };
}

/**
 * `rpc.server-calls`: every frame the Central System sent during the run is valid OCPP-J, and
 * every CALL has a known action and a valid payload.
 *
 * @param label - names the Central System's actions in messages, e.g. `OCPP 1.6 Central System`
 * @param requestSuffix - names a request, e.g. `.req`
 */
export function serverCallsCheck(
  kit: SuiteKit,
  spec: string,
  label: string,
  requestSuffix: string,
): Check {
  const catalogue = kit.protocol.fromCentralSystem;
  return {
    id: 'rpc.server-calls',
    title: 'Sends only valid OCPP-J frames, and CALLs with known actions and valid payloads',
    level: 'MUST',
    spec,
    run(context) {
      const problems: string[] = [];
      let calls = 0;
      for (const connection of context.connections) {
        const ids = new Set<string>();
        for (const record of connection.log) {
          if (record.direction !== 'in') continue;
          let value: unknown;
          try {
            value = JSON.parse(record.raw);
          } catch {
            problems.push(`not JSON: ${clip(record.raw, 120)}`);
            continue;
          }
          if (!Array.isArray(value)) {
            problems.push(`not an array: ${clip(record.raw, 120)}`);
            continue;
          }
          if (value[0] === MessageType.CallResult || value[0] === MessageType.CallError) continue;
          if (value[0] !== MessageType.Call) {
            problems.push(
              `unknown message type ${JSON.stringify(value[0])}: ${clip(record.raw, 120)}`,
            );
            continue;
          }
          calls++;
          const parsed = parseFrame(record.raw, kit.protocol.errorCodes);
          if (!parsed.ok) {
            problems.push(`malformed CALL (${parsed.error.message}): ${clip(record.raw, 120)}`);
            continue;
          }
          if (parsed.frame.type !== MessageType.Call) continue;
          const { action, messageId, payload } = parsed.frame;
          if (ids.has(messageId)) problems.push(`message id ${messageId} reused by ${action}`);
          ids.add(messageId);
          const schema = Object.hasOwn(catalogue, action) ? catalogue[action] : undefined;
          if (!schema) {
            problems.push(`${action} is not an ${label} action`);
            continue;
          }
          const issues = describeIssues(schema.request, payload);
          if (issues.length > 0) {
            problems.push(`${action}${requestSuffix} is invalid: ${issues.slice(0, 2).join('; ')}`);
          }
        }
      }
      if (calls === 0 && problems.length === 0) {
        return Promise.resolve(skip('the Central System sent no CALL during the run'));
      }
      return Promise.resolve(
        problems.length === 0
          ? pass(`all ${calls} CALL(s) were valid`)
          : fail(
              `${problems[0] ?? ''}${problems.length > 1 ? ` (and ${problems.length - 1} more problems)` : ''}`,
              problems.slice(0, 20),
            ),
      );
    },
  };
}

/** `latency`: the 95th percentile Heartbeat round trip stays within the budget. */
export function latencyCheck(kit: SuiteKit, spec: string): Check {
  return {
    id: 'latency',
    title: 'Answers Heartbeats with a 95th percentile round trip within the budget',
    level: 'SHOULD',
    spec,
    async run(context) {
      const { registered, heartbeat, describe } = helpers(kit);
      const connection = await registered(context);
      const { latencySamples, latencyBudgetMs } = context.options;
      const tracker = new LatencyTracker(latencySamples);
      for (let i = 1; i <= latencySamples; i++) {
        const exchange = await heartbeat(connection, context);
        if (exchange.kind !== 'result') {
          return fail(`Heartbeat ${i}/${latencySamples}: ${describe(exchange)}`, exchange.evidence);
        }
        tracker.record(exchange.rttMs);
      }
      const { p50, p95, p99, max } = tracker.summary();
      const summary = `p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, p99 ${p99.toFixed(1)} ms, max ${max.toFixed(1)} ms over ${latencySamples} Heartbeats`;
      return p95 <= latencyBudgetMs
        ? pass(summary)
        : fail(`p95 ${p95.toFixed(1)} ms exceeds the ${latencyBudgetMs} ms budget`, [summary]);
    },
  };
}

/**
 * `rpc.error-codes`: every CALLERROR the Central System sent during the run uses an error code
 * of the negotiated version (a passive check, like `rpc.server-calls`).
 */
export function errorCodesCheck(kit: SuiteKit, spec: string): Check {
  const codes: readonly string[] = kit.protocol.errorCodes.codes;
  return {
    id: 'rpc.error-codes',
    title: `Uses only the error codes of ${kit.protocol.name} in its CALLERRORs`,
    level: 'MUST',
    spec,
    run(context) {
      const seen = new Map<string, string>();
      for (const connection of context.connections) {
        for (const record of connection.log) {
          if (record.direction !== 'in' || rawMessageType(record.raw) !== MessageType.CallError) {
            continue;
          }
          const code = rawErrorCode(record.raw);
          if (!seen.has(code)) seen.set(code, record.raw);
        }
      }
      if (seen.size === 0) {
        return Promise.resolve(skip('the Central System sent no CALLERROR during the run'));
      }
      const foreign = [...seen.keys()].filter((code) => !codes.includes(code));
      return Promise.resolve(
        foreign.length === 0
          ? pass(`all CALLERRORs used ${kit.protocol.name} codes: ${[...seen.keys()].join(', ')}`)
          : fail(
              `used ${foreign.map((code) => `"${code}"`).join(', ')}, which ${kit.protocol.name} does not define`,
              foreign.map((code) => receivedLine(seen.get(code) ?? '')),
            ),
      );
    },
  };
}
