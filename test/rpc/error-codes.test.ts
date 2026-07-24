/**
 * The error vocabulary of each OCPP version: unit tests of the code sets and the translation,
 * and property-based tests that a 2.0.1 connection never speaks 1.6 error codes. Replay a
 * failure with `FC_SEED=<seed>`; `FC_RUNS=<n>` overrides the number of runs.
 */
import type { TSchema } from '@sinclair/typebox';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ChargingStationToCsms,
  CsmsToChargingStation,
  createDuplexPair,
  isOcpp201ErrorCode,
  isOcppErrorCode,
  MessageType,
  OCPP16_ERROR_CODES,
  OCPP201_ERROR_CODES,
  Ocpp201ErrorCodes,
  OcppErrorCodes,
  parseFrame,
  RpcError,
  RpcPeer,
  serializeFrame,
  translateErrorCode,
  validatePayload,
  type ActionSchemaMap,
  type RpcErrorCode,
} from '../../src/index.js';

function parameters(numRuns: number): fc.Parameters<unknown> {
  const seed = process.env.FC_SEED;
  const runs = process.env.FC_RUNS;
  return {
    numRuns: runs === undefined ? numRuns : Number(runs),
    ...(seed === undefined ? {} : { seed: Number(seed) }),
  };
}

const ONLY_16 = ['FormationViolation', 'OccurenceConstraintViolation'];
const ONLY_201 = [
  'FormatViolation',
  'OccurrenceConstraintViolation',
  'MessageTypeNotSupported',
  'RpcFrameworkError',
];

describe('error code sets', () => {
  it('define the ten 1.6 and the twelve 2.0.1 codes', () => {
    expect(OcppErrorCodes).toHaveLength(10);
    expect(Ocpp201ErrorCodes).toHaveLength(12);
    for (const code of ONLY_16) {
      expect(isOcppErrorCode(code)).toBe(true);
      expect(isOcpp201ErrorCode(code)).toBe(false);
    }
    for (const code of ONLY_201) {
      expect(isOcpp201ErrorCode(code)).toBe(true);
      expect(isOcppErrorCode(code)).toBe(false);
    }
  });

  it('use only codes of their own version in every role', () => {
    for (const set of [OCPP16_ERROR_CODES, OCPP201_ERROR_CODES]) {
      for (const [role, code] of Object.entries(set)) {
        if (role === 'codes') continue;
        expect(set.codes, role).toContain(code);
      }
    }
  });

  it('translate between the two spellings and leave unknown codes out', () => {
    expect(translateErrorCode('FormationViolation', OCPP201_ERROR_CODES)).toBe('FormatViolation');
    expect(translateErrorCode('OccurenceConstraintViolation', OCPP201_ERROR_CODES)).toBe(
      'OccurrenceConstraintViolation',
    );
    expect(translateErrorCode('FormatViolation', OCPP16_ERROR_CODES)).toBe('FormationViolation');
    expect(translateErrorCode('OccurrenceConstraintViolation', OCPP16_ERROR_CODES)).toBe(
      'OccurenceConstraintViolation',
    );
    expect(translateErrorCode('RpcFrameworkError', OCPP16_ERROR_CODES)).toBe('FormationViolation');
    expect(translateErrorCode('MessageTypeNotSupported', OCPP16_ERROR_CODES)).toBeUndefined();
    expect(translateErrorCode('SecurityError', OCPP201_ERROR_CODES)).toBe('SecurityError');
    expect(translateErrorCode('Nonsense', OCPP201_ERROR_CODES)).toBeUndefined();
  });
});

describe('parseFrame with the 2.0.1 codes', () => {
  const parse = (raw: string) => parseFrame(raw, OCPP201_ERROR_CODES);

  it.each([
    ['not JSON', '[2,"a","Heartbeat",{', 'RpcFrameworkError'],
    ['not an array', '{"a":1}', 'RpcFrameworkError'],
    ['numeric message id', '[2,1,"Heartbeat",{}]', 'RpcFrameworkError'],
    ['too long message id', `[2,"${'x'.repeat(37)}","Heartbeat",{}]`, 'RpcFrameworkError'],
    ['too few elements', '[2,"a","Heartbeat"]', 'RpcFrameworkError'],
    ['too many elements', '[2,"a","Heartbeat",{},1]', 'RpcFrameworkError'],
    ['numeric action', '[2,"a",5,{}]', 'RpcFrameworkError'],
    ['string payload', '[2,"a","Heartbeat","x"]', 'FormatViolation'],
    ['unknown message type', '[7,"a",{}]', 'ProtocolError'],
  ])('%s: %s', (_label, raw, code) => {
    const result = parse(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('keeps 2.0.1 codes of received CALLERRORs and maps 1.6 codes to GenericError', () => {
    const kept = parse('[4,"a","FormatViolation","bad",{}]');
    expect(kept.ok && kept.frame.type === MessageType.CallError && kept.frame.errorCode).toBe(
      'FormatViolation',
    );
    const mapped = parse('[4,"a","FormationViolation","bad",{"x":1}]');
    expect(mapped.ok && mapped.frame).toMatchObject({
      errorCode: 'GenericError',
      errorDetails: { x: 1, originalErrorCode: 'FormationViolation' },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Property-based

const json = fc.jsonValue({ maxDepth: 3 });
const actions201 = [...Object.keys(ChargingStationToCsms), ...Object.keys(CsmsToChargingStation)];
const frameLike = fc
  .array(
    fc.oneof(
      fc.constantFrom<unknown>(2, 3, 4, 5, 0, '2', null),
      fc.string({ minLength: 1, maxLength: 40 }),
      fc.constantFrom(...actions201),
      fc.constantFrom(...OcppErrorCodes, ...Ocpp201ErrorCodes),
      fc.dictionary(fc.string({ maxLength: 8 }), json, { maxKeys: 4 }),
      json,
    ),
    { maxLength: 6 },
  )
  .map((elements) => JSON.stringify(elements));
const wireText = fc.oneof(fc.string({ maxLength: 60 }), frameLike);

/** Every schema of the 2.0.1 catalogue. */
const schemas: TSchema[] = [ChargingStationToCsms, CsmsToChargingStation].flatMap(
  (map: ActionSchemaMap) =>
    Object.values(map).flatMap(({ request, response }) => [request, response]),
);

describe('2.0.1 error codes (property-based)', () => {
  it('parseFrame only ever reports 2.0.1 codes, and agrees with the 1.6 parse role by role', () => {
    fc.assert(
      fc.property(wireText, (raw) => {
        const v201 = parseFrame(raw, OCPP201_ERROR_CODES);
        const v16 = parseFrame(raw);
        expect(v201.ok).toBe(v16.ok);
        if (!v201.ok && !v16.ok) {
          expect(isOcpp201ErrorCode(v201.error.code)).toBe(true);
          expect(v201.messageId).toBe(v16.messageId);
          expect(v201.messageType).toBe(v16.messageType);
          // Each 1.6 framing code has exactly the 2.0.1 counterparts of its roles.
          const counterparts: Record<string, readonly RpcErrorCode[]> = {
            FormationViolation: ['RpcFrameworkError', 'FormatViolation'],
            ProtocolError: ['RpcFrameworkError', 'ProtocolError'],
          };
          expect(counterparts[v16.error.code]).toContain(v201.error.code);
        }
        if (v201.ok && v201.frame.type === MessageType.CallError) {
          expect(isOcpp201ErrorCode(v201.frame.errorCode)).toBe(true);
        }
      }),
      parameters(2_000),
    );
  });

  it('validation reports the 2.0.1 spelling of the code the 1.6 vocabulary reports', () => {
    fc.assert(
      fc.property(fc.constantFrom(...schemas), json, (schema, value) => {
        const v201 = validatePayload(schema, value, 'x', OCPP201_ERROR_CODES);
        const v16 = validatePayload(schema, value);
        expect(v201 === undefined).toBe(v16 === undefined);
        if (v201 && v16) {
          expect([
            'FormatViolation',
            'OccurrenceConstraintViolation',
            'TypeConstraintViolation',
            'PropertyConstraintViolation',
          ]).toContain(v201.code);
          expect(v201.code).toBe(translateErrorCode(v16.code, OCPP201_ERROR_CODES));
        }
      }),
      parameters(1_000),
    );
  });

  it('an RpcPeer on a 2.0.1 connection answers every CALL once, with 2.0.1 codes only', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            wireText,
            fc
              .record({
                id: fc.uuid(),
                action: fc.constantFrom(...Object.keys(ChargingStationToCsms), 'Unknown'),
                payload: fc.dictionary(fc.string({ maxLength: 8 }), json, { maxKeys: 3 }),
              })
              .map(({ id, action, payload }) => JSON.stringify([2, id, action, payload])),
          ),
          { maxLength: 8 },
        ),
        fc.constantFrom<RpcErrorCode>(...OcppErrorCodes, ...Ocpp201ErrorCodes),
        async (frames, thrown) => {
          const [remote, local] = createDuplexPair();
          const sent: unknown[][] = [];
          remote.attach({
            message: (data) => sent.push(JSON.parse(data) as unknown[]),
            close: () => undefined,
          });
          const peer = new RpcPeer(local, {
            inbound: ChargingStationToCsms,
            outbound: CsmsToChargingStation,
            errorCodes: OCPP201_ERROR_CODES,
          });
          // One handler answers, one throws a code of either vocabulary.
          peer.handle('Heartbeat', () => ({ currentTime: '2026-09-26T10:00:00.000Z' }));
          peer.handle('StatusNotification', () => {
            throw new RpcError(thrown, 'refused');
          });
          for (const raw of frames) remote.send(raw);
          for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
          for (const frame of sent) {
            if (frame[0] === MessageType.CallError) {
              expect(isOcpp201ErrorCode(frame[2])).toBe(true);
              const known = translateErrorCode(thrown, OCPP201_ERROR_CODES);
              if (frame[3] === 'refused') {
                expect(frame[2]).toBe(known ?? 'GenericError');
                if (known === undefined) {
                  expect(frame[4]).toMatchObject({ originalErrorCode: thrown });
                }
              }
            }
          }
          // No CALL with a recoverable id is answered twice, unless its id repeats.
          const ids = sent.map((frame) => frame[1]);
          const callIds = frames.flatMap((raw) => {
            try {
              const value: unknown = JSON.parse(raw);
              return Array.isArray(value) && value[0] === 2 ? [value[1] as unknown] : [];
            } catch {
              return [];
            }
          });
          for (const id of new Set(ids)) {
            const answers = ids.filter((candidate) => candidate === id).length;
            const calls = callIds.filter((candidate) => candidate === id).length;
            expect(answers).toBeLessThanOrEqual(Math.max(1, calls));
          }
          await peer.close();
        },
      ),
      parameters(300),
    );
  });

  it('serializes and re-parses every 2.0.1 CALLERROR unchanged', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.constantFrom(...Ocpp201ErrorCodes),
        fc.string({ maxLength: 40 }),
        (messageId, errorCode, errorDescription) => {
          const raw = serializeFrame({
            type: MessageType.CallError,
            messageId,
            errorCode,
            errorDescription,
            errorDetails: {},
          });
          const parsed = parseFrame(raw, OCPP201_ERROR_CODES);
          expect(parsed.ok && parsed.frame).toEqual({
            type: MessageType.CallError,
            messageId,
            errorCode,
            errorDescription,
            errorDetails: {},
          });
        },
      ),
      parameters(500),
    );
  });
});
