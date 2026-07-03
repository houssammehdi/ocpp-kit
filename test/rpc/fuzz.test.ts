/**
 * Property-based tests of the frame parser and RpcPeer. A failure prints the seed and the
 * shrunk counterexample; replay it with `FC_SEED=<seed> npx vitest run test/rpc/fuzz.test.ts`.
 * `FC_RUNS=<n>` overrides the number of runs of every property (e.g. for a longer soak).
 */
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CentralSystemToChargePoint,
  ChargePointToCentralSystem,
} from '../../src/messages/index.js';
import {
  createDuplexPair,
  isOcppErrorCode,
  MAX_MESSAGE_ID_LENGTH,
  MessageType,
  OcppErrorCodes,
  parseFrame,
  RpcPeer,
  serializeFrame,
  type Frame,
  type JsonObject,
} from '../../src/rpc/index.js';
import { NOW, rawPair } from '../helpers.js';

function parameters(numRuns: number): fc.Parameters<unknown> {
  const seed = process.env.FC_SEED;
  const runs = process.env.FC_RUNS;
  return {
    numRuns: runs === undefined ? numRuns : Number(runs),
    ...(seed === undefined ? {} : { seed: Number(seed) }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Let queued microtasks and immediates (message delivery, async handlers) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------------------------
// Arbitraries

const json = fc.jsonValue({ maxDepth: 3 });
const text = (maxLength: number) => fc.string({ unit: 'binary', maxLength });
const messageId = fc
  .string({ unit: 'binary', minLength: 1, maxLength: MAX_MESSAGE_ID_LENGTH })
  .filter((id) => id.length <= MAX_MESSAGE_ID_LENGTH);
const payload = fc.dictionary(fc.string({ maxLength: 12 }), json, { maxKeys: 5 }) as fc.Arbitrary<
  Record<string, unknown>
>;
const knownAction = fc.constantFrom(
  ...Object.keys(ChargePointToCentralSystem),
  ...Object.keys(CentralSystemToChargePoint),
);
const action = fc.oneof(knownAction, fc.string({ minLength: 1, maxLength: 20 }));

/** A structurally valid frame. */
const frame: fc.Arbitrary<Frame> = fc.oneof(
  fc.record({ type: fc.constant(MessageType.Call), messageId, action, payload }),
  fc.record({ type: fc.constant(MessageType.CallResult), messageId, payload }),
  fc.record({
    type: fc.constant(MessageType.CallError),
    messageId,
    errorCode: fc.constantFrom(...OcppErrorCodes),
    errorDescription: text(40),
    errorDetails: payload,
  }),
);

/** Arrays that look like frames but break them in every position. */
const frameLike = fc
  .array(
    fc.oneof(
      fc.constantFrom<unknown>(2, 3, 4, 5, 0, -1, '2', null),
      messageId,
      action,
      payload,
      json,
      fc.string({ minLength: 37, maxLength: 60 }),
    ),
    { maxLength: 7 },
  )
  .map((elements) => JSON.stringify(elements));

/** Any text a peer may receive: noise, arbitrary JSON, broken frames and valid frames. */
const wireText = fc.oneof(
  text(80),
  json.map((value) => JSON.stringify(value)),
  frameLike,
  frame.map(serializeFrame),
);

// ---------------------------------------------------------------------------------------------

describe('parseFrame (property-based)', () => {
  it('never throws, and classifies every input consistently', () => {
    fc.assert(
      fc.property(wireText, (raw) => {
        const result = parseFrame(raw);
        if (result.ok) {
          const { frame: parsed } = result;
          expect([MessageType.Call, MessageType.CallResult, MessageType.CallError]).toContain(
            parsed.type,
          );
          expect(parsed.messageId.length).toBeGreaterThan(0);
          expect(parsed.messageId.length).toBeLessThanOrEqual(MAX_MESSAGE_ID_LENGTH);
          if (parsed.type === MessageType.CallError) {
            expect(isOcppErrorCode(parsed.errorCode)).toBe(true);
          }
        } else {
          expect(isOcppErrorCode(result.error.code)).toBe(true);
          if (result.messageType !== undefined) expect(typeof result.messageId).toBe('string');
          if (result.messageType === MessageType.Call) {
            expect(['FormationViolation', 'ProtocolError']).toContain(result.error.code);
          }
        }
      }),
      parameters(2_000),
    );
  });

  it('round-trips every valid frame through serializeFrame', () => {
    fc.assert(
      fc.property(frame, (original) => {
        const raw = serializeFrame(original);
        const result = parseFrame(raw);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // JSON has no -0: compare with the JSON-normalised original.
        expect(result.frame).toEqual(JSON.parse(JSON.stringify(original)));
        expect(serializeFrame(result.frame)).toBe(raw);
      }),
      parameters(2_000),
    );
  });
});

/** What a well-behaved peer must send back for one received frame. */
function expectedAnswerCode(
  raw: string,
): { readonly id: string; readonly code?: string } | undefined {
  const result = parseFrame(raw);
  if (result.ok) {
    return result.frame.type === MessageType.Call ? { id: result.frame.messageId } : undefined;
  }
  if (result.messageType === MessageType.Call && result.messageId !== undefined) {
    return { id: result.messageId, code: result.error.code };
  }
  return undefined;
}

describe('RpcPeer (property-based)', () => {
  it('answers every CALL exactly once with a valid response and ignores everything else', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(wireText, { maxLength: 25 }), async (inputs) => {
        const { cs, remote, received } = rawPair();
        cs.handle('Heartbeat', async () => {
          await Promise.resolve();
          return { currentTime: NOW };
        });
        for (const raw of inputs) remote.send(raw);
        await settle();

        const expected = inputs.flatMap((raw) => expectedAnswerCode(raw) ?? []);
        const answers = received.map((raw) => JSON.parse(raw) as unknown[]);
        // Exactly one answer per CALL, matched by message id.
        const count = (ids: readonly unknown[]) => {
          const counts = new Map<unknown, number>();
          for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
          return counts;
        };
        expect(count(answers.map((answer) => answer[1]))).toEqual(
          count(expected.map((entry) => entry.id)),
        );
        for (const answer of answers) {
          const [type, id, ...rest] = answer;
          expect(typeof id).toBe('string');
          if (type === MessageType.CallResult) {
            expect(rest).toHaveLength(1);
            expect(rest[0]).toBeTypeOf('object');
          } else {
            expect(type).toBe(MessageType.CallError);
            const [code, description, details] = rest;
            expect(isOcppErrorCode(code)).toBe(true);
            expect(typeof description).toBe('string');
            expect(details).toBeTypeOf('object');
          }
        }
        // A malformed CALL gets the CALLERROR code its parse failure maps to.
        for (const entry of expected) {
          if (entry.code === undefined) continue;
          expect(
            answers.some(
              (a) => a[0] === MessageType.CallError && a[1] === entry.id && a[2] === entry.code,
            ),
          ).toBe(true);
        }
        // Answers to valid ids are valid frames themselves.
        for (const raw of received) {
          const [, id] = JSON.parse(raw) as unknown[];
          if (typeof id === 'string' && id.length > 0 && id.length <= MAX_MESSAGE_ID_LENGTH) {
            expect(parseFrame(raw).ok).toBe(true);
          }
        }
        await cs.close();
      }),
      parameters(300),
    );
  });

  type Event =
    | { readonly kind: 'call'; readonly timeoutMs: number }
    | { readonly kind: 'answer'; readonly which: number; readonly error: boolean }
    | { readonly kind: 'stray'; readonly raw: string }
    | { readonly kind: 'abort'; readonly which: number }
    | { readonly kind: 'tick'; readonly ms: number }
    | { readonly kind: 'inbound' };

  const event: fc.Arbitrary<Event> = fc.oneof(
    fc.record({ kind: fc.constant('call' as const), timeoutMs: fc.integer({ min: 1, max: 500 }) }),
    fc.record({
      kind: fc.constant('answer' as const),
      which: fc.nat({ max: 10 }),
      error: fc.boolean(),
    }),
    fc.record({ kind: fc.constant('stray' as const), raw: wireText }),
    fc.record({ kind: fc.constant('abort' as const), which: fc.nat({ max: 10 }) }),
    fc.record({ kind: fc.constant('tick' as const), ms: fc.integer({ min: 0, max: 600 }) }),
    fc.record({ kind: fc.constant('inbound' as const) }),
  );

  it('never has two CALLs outstanding, and never reuses a message id', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(event, { maxLength: 40 }), async (events) => {
        vi.useFakeTimers();
        const [local, remote] = createDuplexPair();
        const peer = new RpcPeer(local, {
          inbound: CentralSystemToChargePoint,
          outbound: ChargePointToCentralSystem,
        });
        peer.handle('ClearCache', () => ({ status: 'Accepted' }));
        const sent = new Set<string>();
        const outstanding = new Set<string>();
        const problems: string[] = [];
        peer.on('message', (direction, raw) => {
          if (direction !== 'out') return;
          const parsed = parseFrame(raw);
          if (!parsed.ok || parsed.frame.type !== MessageType.Call) return;
          const { messageId: id } = parsed.frame;
          if (outstanding.size > 0)
            problems.push(`sent ${id} while ${[...outstanding].join()} was outstanding`);
          if (sent.has(id)) problems.push(`reused ${id}`);
          sent.add(id);
          outstanding.add(id);
        });
        peer.on('callCompleted', ({ messageId: id }) => outstanding.delete(id));

        const unanswered: string[] = [];
        remote.attach({
          message: (raw) => {
            const parsed = parseFrame(raw);
            if (parsed.ok && parsed.frame.type === MessageType.Call)
              unanswered.push(parsed.frame.messageId);
          },
          close: () => undefined,
        });
        const controllers: AbortController[] = [];
        let made = 0;
        let settled = 0;
        let inbound = 0;
        for (const step of events) {
          switch (step.kind) {
            case 'call': {
              const controller = new AbortController();
              controllers.push(controller);
              made++;
              peer
                .call('Heartbeat', {}, { timeoutMs: step.timeoutMs, signal: controller.signal })
                .then(
                  () => settled++,
                  () => settled++,
                );
              break;
            }
            case 'answer': {
              if (unanswered.length === 0) break;
              const [id] = unanswered.splice(step.which % unanswered.length, 1);
              remote.send(
                JSON.stringify(
                  step.error ? [4, id, 'InternalError', '', {}] : [3, id, { currentTime: NOW }],
                ),
              );
              break;
            }
            case 'stray':
              remote.send(step.raw);
              break;
            case 'abort':
              controllers[step.which % Math.max(1, controllers.length)]?.abort();
              break;
            case 'tick':
              vi.advanceTimersByTime(step.ms);
              break;
            case 'inbound':
              remote.send(
                JSON.stringify([2, `inbound-${inbound++}`, 'ClearCache', {}] satisfies unknown[]),
              );
              break;
          }
          await vi.advanceTimersByTimeAsync(0);
        }
        // Every call ends: answered, aborted, or timed out one after another.
        await vi.advanceTimersByTimeAsync(501 * (made + 1));
        expect(problems).toEqual([]);
        expect(settled).toBe(made);
        expect(outstanding.size).toBe(0);
        vi.useRealTimers();
      }),
      parameters(300),
    );
  });

  it('keeps answering after arbitrary garbage in any order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(wireText, { maxLength: 15 }), async (noise) => {
        const { cs, remote, received } = rawPair();
        cs.handle('Heartbeat', () => ({ currentTime: NOW }));
        for (const raw of noise) remote.send(raw);
        await settle();
        const before = received.length;
        remote.send(JSON.stringify([2, 'final-check', 'Heartbeat', {}] satisfies unknown[]));
        await settle();
        expect(received.slice(before)).toContain(
          JSON.stringify([3, 'final-check', { currentTime: NOW } satisfies JsonObject]),
        );
        expect(cs.isOpen).toBe(true);
      }),
      parameters(200),
    );
  });
});
