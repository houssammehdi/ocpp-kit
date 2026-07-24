import type { TSchema } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import {
  ACTION_BLOCKS,
  ChargingStationToCsms,
  CsmsToChargingStation,
  FUNCTIONAL_BLOCKS,
  OCPP16_ERROR_CODES,
  OCPP201_ERROR_CODES,
  OCPP201_PROTOCOL,
  UNSUPPORTED_ACTIONS_201,
  validatePayload,
  type ActionSchemaMap,
} from '../../src/index.js';
import { CSMS_EXAMPLES, STATION_EXAMPLES } from './v201-examples.js';

interface Case {
  readonly name: string;
  readonly schema: TSchema;
  readonly example: Record<string, unknown>;
}

function cases(map: ActionSchemaMap, examples: object, prefix: string): Case[] {
  return Object.entries(map).flatMap(([action, { request, response }]) => {
    const example = (examples as Record<string, { request: object; response: object }>)[action];
    if (!example) throw new Error(`no example for ${action}`);
    return [
      {
        name: `${prefix} ${action}Request`,
        schema: request,
        example: example.request as Record<string, unknown>,
      },
      {
        name: `${prefix} ${action}Response`,
        schema: response,
        example: example.response as Record<string, unknown>,
      },
    ];
  });
}

const ALL: Case[] = [
  ...cases(ChargingStationToCsms, STATION_EXAMPLES, 'CS->CSMS'),
  ...cases(CsmsToChargingStation, CSMS_EXAMPLES, 'CSMS->CS'),
];

const validate = (schema: TSchema, value: unknown) =>
  validatePayload(schema, value, 'Payload', OCPP201_ERROR_CODES);

interface PropertySchema {
  readonly type?: string;
  readonly maxLength?: number;
  readonly anyOf?: readonly { readonly const?: unknown }[];
  readonly pattern?: string;
}

function properties(schema: TSchema): [string, PropertySchema][] {
  return Object.entries(
    (schema as { properties?: Record<string, PropertySchema> }).properties ?? {},
  );
}

describe('OCPP 2.0.1 catalogue', () => {
  it('has 40 messages, each in one functional block, and lists the 24 it leaves out', () => {
    const actions = new Set([
      ...Object.keys(ChargingStationToCsms),
      ...Object.keys(CsmsToChargingStation),
    ]);
    expect(actions.size).toBe(40);
    expect(new Set(Object.keys(ACTION_BLOCKS))).toEqual(actions);
    for (const block of Object.values(ACTION_BLOCKS))
      expect(FUNCTIONAL_BLOCKS).toHaveProperty(block);
    expect(UNSUPPORTED_ACTIONS_201).toHaveLength(24);
    for (const action of UNSUPPORTED_ACTIONS_201) expect(actions.has(action)).toBe(false);
    expect(OCPP201_PROTOCOL.subprotocol).toBe('ocpp2.0.1');
    expect(OCPP201_PROTOCOL.transactionActions).toEqual(['TransactionEvent']);
  });

  it.each(ALL)('$name: accepts the example', ({ schema, example }) => {
    expect(validate(schema, example)).toBeUndefined();
  });

  it.each(ALL)(
    '$name: accepts customData and refuses undeclared properties',
    ({ schema, example }) => {
      expect(
        validate(schema, { ...example, customData: { vendorId: 'com.example', x: 1 } }),
      ).toBeUndefined();
      expect(validate(schema, { ...example, customData: { x: 1 } })?.code).toBe(
        'OccurrenceConstraintViolation',
      );
      expect(validate(schema, { ...example, undeclared: true })?.code).toBe('FormatViolation');
      // The same fault in the 1.6 vocabulary.
      expect(
        validatePayload(schema, { ...example, undeclared: true }, 'x', OCPP16_ERROR_CODES)?.code,
      ).toBe('FormationViolation');
    },
  );

  it.each(ALL)('$name: reports each missing required field', ({ schema, example }) => {
    for (const field of (schema as { required?: string[] }).required ?? []) {
      const rest = Object.fromEntries(Object.entries(example).filter(([key]) => key !== field));
      expect(validate(schema, rest)?.code, field).toBe('OccurrenceConstraintViolation');
    }
  });

  it.each(ALL)(
    '$name: reports wrong types, bad values and over-long strings',
    ({ schema, example }) => {
      for (const [field, property] of properties(schema)) {
        if (field === 'customData') continue;
        if (property.type === 'integer' || property.type === 'number') {
          expect(validate(schema, { ...example, [field]: '1' })?.code, field).toBe(
            'TypeConstraintViolation',
          );
        }
        if (property.type === 'boolean') {
          expect(validate(schema, { ...example, [field]: 'true' })?.code, field).toBe(
            'TypeConstraintViolation',
          );
        }
        if (property.type === 'string' && property.maxLength !== undefined) {
          const long = 'x'.repeat(property.maxLength + 1);
          expect(validate(schema, { ...example, [field]: long })?.code, field).toBe(
            'PropertyConstraintViolation',
          );
        }
        if (property.type === 'string' && property.pattern !== undefined) {
          expect(validate(schema, { ...example, [field]: 'yesterday' })?.code, field).toBe(
            'PropertyConstraintViolation',
          );
        }
        if (property.anyOf?.every((variant) => typeof variant.const === 'string')) {
          expect(validate(schema, { ...example, [field]: 'NoSuchValue' })?.code, field).toBe(
            'PropertyConstraintViolation',
          );
          expect(validate(schema, { ...example, [field]: 7 })?.code, field).toBe(
            'TypeConstraintViolation',
          );
        }
      }
    },
  );

  it('validates nested objects: idToken, EVSE, sampled values', () => {
    const request = STATION_EXAMPLES.TransactionEvent.request;
    const schema = ChargingStationToCsms.TransactionEvent.request;
    expect(validate(schema, { ...request, idToken: { idToken: 'X' } })?.code).toBe(
      'OccurrenceConstraintViolation',
    );
    expect(validate(schema, { ...request, evse: { id: '1' } })?.code).toBe(
      'TypeConstraintViolation',
    );
    const meterValue = [{ timestamp: request.timestamp, sampledValue: [{ value: '12.5' }] }];
    // The 1.6 habit of sending meter readings as strings is a type error in 2.0.1.
    expect(validate(schema, { ...request, meterValue })?.code).toBe('TypeConstraintViolation');
    expect(validate(schema, { ...request, meterValue: [] })?.code).toBe(
      'OccurrenceConstraintViolation',
    );
  });

  it('limits a charging profile to three schedules and accepts any JSON as DataTransfer data', () => {
    const { request } = CSMS_EXAMPLES.SetChargingProfile;
    const schedule = request.chargingProfile.chargingSchedule[0]!;
    const four = {
      ...request.chargingProfile,
      chargingSchedule: [schedule, schedule, schedule, schedule],
    };
    expect(
      validate(CsmsToChargingStation.SetChargingProfile.request, {
        ...request,
        chargingProfile: four,
      })?.code,
    ).toBe('OccurrenceConstraintViolation');
    for (const data of [null, 1, 'text', [1], { a: { b: true } }]) {
      expect(
        validate(ChargingStationToCsms.DataTransfer.request, { vendorId: 'v', data }),
      ).toBeUndefined();
    }
  });
});
