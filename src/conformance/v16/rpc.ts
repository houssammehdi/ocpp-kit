/** OCPP-J 1.6 checks of the RPC framework: error handling, robustness, synchronicity. */
import { randomUUID } from 'node:crypto';
import { CentralSystemToChargePoint } from '../../messages/index.js';
import { isOcppErrorCode } from '../../rpc/errors.js';
import { MAX_MESSAGE_ID_LENGTH, MessageType, parseFrame } from '../../rpc/frames.js';
import { LatencyTracker } from '../../simulator/stats.js';
import type { ProbeConnection } from '../probe.js';
import type { Check, CheckContext, CheckOutcome } from '../types.js';
import {
  boot,
  clip,
  describe,
  describeIssues,
  fail,
  failed,
  grace,
  now,
  pass,
  rawErrorCode,
  receivedLine,
  registered,
  send,
  sentLine,
  serviceProblem,
  skip,
  sleep,
} from './shared.js';

/** State key of the error code `rpc.unknown-action` received. */
const UNKNOWN_ACTION_CODE = 'v16.unknownActionCode';

/**
 * Send a frame followed by a Heartbeat, give straggling answers a moment, and report what came
 * back mentioning `id`, which CALLERRORs arrived meanwhile, and whether the Central System still
 * serves the connection.
 */
async function probeWithFrame(
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
  const mark = connection.log.length;
  connection.send(raw);
  const heartbeat = await send(connection, 'Heartbeat', {}, context.options.timeoutMs);
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

/** The message type of a raw frame, if it is a JSON array. */
function rawMessageType(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value[0] : undefined;
  } catch {
    return undefined;
  }
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

export const unknownAction: Check = {
  id: 'rpc.unknown-action',
  title: 'Answers a CALL with an unknown action with a CALLERROR',
  level: 'MUST',
  spec: 'OCPP-J 1.6 §4.2.3',
  async run(context) {
    const connection = await registered(context);
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
    if (!isOcppErrorCode(code)) {
      return fail(`answered with the error code "${code}", which OCPP-J does not define`, evidence);
    }
    context.state.set(UNKNOWN_ACTION_CODE, code);
    return pass(`CALLERROR ${code}`, evidence);
  },
};

export const unknownActionCode: Check = {
  id: 'rpc.unknown-action-code',
  title: 'Uses the NotImplemented error code for unknown actions',
  level: 'SHOULD',
  spec: 'OCPP-J 1.6 §4.2.3 (NotImplemented: requested Action is not known by receiver)',
  requires: ['rpc.unknown-action'],
  run(context) {
    const code = String(context.state.get(UNKNOWN_ACTION_CODE));
    return Promise.resolve(
      code === 'NotImplemented'
        ? pass('NotImplemented')
        : fail(`${code} instead of NotImplemented`),
    );
  },
};

interface MalformedCase {
  readonly label: string;
  readonly raw: (id: string) => string;
  readonly id?: string;
  readonly expected: readonly string[];
}

/** Send each case and require a CALLERROR with one of its expected codes. */
async function expectCallErrors(
  context: CheckContext,
  cases: readonly MalformedCase[],
): Promise<CheckOutcome> {
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

export const invalidPayload: Check = {
  id: 'rpc.invalid-payload',
  title: 'Answers schema-violating payloads with a fitting CALLERROR',
  level: 'SHOULD',
  spec: 'OCPP-J 1.6 §4.2.3',
  run(context) {
    const call = (payload: string) => (id: string) =>
      `[2,${JSON.stringify(id)},"Authorize",${payload}]`;
    return expectCallErrors(context, [
      {
        label: 'Authorize without idTag',
        raw: call('{}'),
        expected: ['OccurenceConstraintViolation', 'ProtocolError', 'FormationViolation'],
      },
      {
        label: 'Authorize with a numeric idTag',
        raw: call('{"idTag":12345}'),
        expected: ['TypeConstraintViolation', 'FormationViolation'],
      },
      {
        label: 'Authorize with a 21-character idTag',
        raw: call(JSON.stringify({ idTag: 'X'.repeat(21) })),
        expected: [
          'PropertyConstraintViolation',
          'OccurenceConstraintViolation',
          'FormationViolation',
        ],
      },
    ]);
  },
};

export const malformedFrame: Check = {
  id: 'rpc.malformed-frame',
  title: 'Answers structurally invalid CALL frames with a CALLERROR',
  level: 'SHOULD',
  spec: 'OCPP-J 1.6 §4.2.3',
  run(context) {
    return expectCallErrors(context, [
      {
        label: 'CALL without payload',
        raw: (id) => `[2,${JSON.stringify(id)},"Heartbeat"]`,
        expected: ['ProtocolError', 'FormationViolation'],
      },
      {
        label: 'CALL whose payload is a string',
        raw: (id) => `[2,${JSON.stringify(id)},"Heartbeat","payload"]`,
        expected: ['FormationViolation', 'TypeConstraintViolation'],
      },
      {
        label: `message id longer than ${MAX_MESSAGE_ID_LENGTH} characters`,
        id: `${randomUUID()}-x`,
        raw: (id) => `[2,${JSON.stringify(id)},"Heartbeat",{}]`,
        expected: ['FormationViolation', 'ProtocolError', 'PropertyConstraintViolation'],
      },
    ]);
  },
};

export const malformedJson: Check = {
  id: 'rpc.malformed-json',
  title: 'Keeps serving after a frame that is not valid JSON',
  level: 'SHOULD',
  spec: 'Robustness (OCPP-J 1.6 §4.2.3: no message id to answer)',
  async run(context) {
    const connection = await registered(context);
    const id = randomUUID();
    const { problem, evidence, callErrors } = await probeWithFrame(
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

export const unknownMessageType: Check = {
  id: 'rpc.unknown-message-type',
  title: 'Ignores frames with an unknown message type',
  level: 'MUST',
  spec: 'OCPP-J 1.6 §4.1.3',
  async run(context) {
    const connection = await registered(context);
    const id = randomUUID();
    const { problem, evidence, replies } = await probeWithFrame(
      connection,
      context,
      `[7,"${id}",{}]`,
      id,
    );
    if (problem) return fail(problem, evidence);
    if (replies.length > 0)
      return fail('answered a frame of message type 7 instead of ignoring it', evidence);
    return pass('ignored it and kept serving', evidence);
  },
};

export const unmatchedResponse: Check = {
  id: 'rpc.unmatched-response',
  title: 'Ignores a CALLRESULT or CALLERROR that answers no CALL',
  level: 'SHOULD',
  spec: 'Robustness (OCPP-J 1.6 §4.1.4: responses are matched by message id)',
  async run(context) {
    const connection = await registered(context);
    const details: string[] = [];
    for (const raw of [
      (id: string) => `[3,"${id}",{}]`,
      (id: string) => `[4,"${id}","GenericError","",{}]`,
    ]) {
      const id = randomUUID();
      const outcome = await probeWithFrame(connection, context, raw(id), id);
      details.push(...outcome.evidence);
      if (outcome.problem) return fail(outcome.problem, details);
      if (outcome.replies.length > 0) return fail('answered an unmatched response', details);
    }
    return pass('ignored both and kept serving', details);
  },
};

export const singleOutstandingCall: Check = {
  id: 'rpc.single-outstanding-call',
  title: 'Sends no second CALL while one is unanswered',
  level: 'SHOULD',
  spec: 'OCPP-J 1.6 §4.1.1',
  async run(context) {
    const { observeMs, timeoutMs } = context.options;
    // A fresh registration invites the CALLs Central Systems send after a boot; an Available
    // connector invites a RemoteStartTransaction.
    await context.endSession();
    const connection = await context.connect();
    connection.answerCalls({ delayMs: observeMs });
    const exchange = await boot(connection, context);
    if (exchange.kind !== 'result' || exchange.payload.status !== 'Accepted') {
      throw new Error(`registration failed: ${describe(exchange)}`);
    }
    await send(
      connection,
      'StatusNotification',
      { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: now() },
      timeoutMs,
    );
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

export const serverCalls: Check = {
  id: 'rpc.server-calls',
  title: 'Sends only valid OCPP-J frames, and CALLs with known actions and valid payloads',
  level: 'MUST',
  spec: 'OCPP-J 1.6 §4.1.3, §4.1.4, §4.2.1; OCPP 1.6 JSON schemas',
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
        const parsed = parseFrame(record.raw);
        if (!parsed.ok) {
          problems.push(`malformed CALL (${parsed.error.message}): ${clip(record.raw, 120)}`);
          continue;
        }
        if (parsed.frame.type !== MessageType.Call) continue;
        const { action, messageId, payload } = parsed.frame;
        if (ids.has(messageId)) problems.push(`message id ${messageId} reused by ${action}`);
        ids.add(messageId);
        if (!Object.hasOwn(CentralSystemToChargePoint, action)) {
          problems.push(`${action} is not an OCPP 1.6 Central System action`);
          continue;
        }
        const schema =
          CentralSystemToChargePoint[action as keyof typeof CentralSystemToChargePoint];
        const issues = describeIssues(schema.request, payload);
        if (issues.length > 0) {
          problems.push(`${action}.req is invalid: ${issues.slice(0, 2).join('; ')}`);
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

export const latency: Check = {
  id: 'latency',
  title: 'Answers Heartbeats with a 95th percentile round trip within the budget',
  level: 'SHOULD',
  spec: 'Performance (OCPP does not specify response times)',
  async run(context) {
    const connection = await registered(context);
    const { latencySamples, latencyBudgetMs, timeoutMs } = context.options;
    const tracker = new LatencyTracker(latencySamples);
    for (let i = 1; i <= latencySamples; i++) {
      const exchange = await send(connection, 'Heartbeat', {}, timeoutMs);
      if (exchange.kind !== 'result') return failed(exchange, `Heartbeat ${i}/${latencySamples}: `);
      tracker.record(exchange.rttMs);
    }
    const { p50, p95, p99, max } = tracker.summary();
    const summary = `p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, p99 ${p99.toFixed(1)} ms, max ${max.toFixed(1)} ms over ${latencySamples} Heartbeats`;
    return p95 <= latencyBudgetMs
      ? pass(summary)
      : fail(`p95 ${p95.toFixed(1)} ms exceeds the ${latencyBudgetMs} ms budget`, [summary]);
  },
};
