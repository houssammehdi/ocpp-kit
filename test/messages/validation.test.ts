import { describe, expect, it } from 'vitest';
import {
  BootNotificationRequest,
  BootNotificationResponse,
  CentralSystemToChargePoint,
  ChargePointToCentralSystem,
  MeterValuesRequest,
  SetChargingProfileRequest,
  StartTransactionRequest,
  StatusNotificationRequest,
  TriggerMessageRequest,
} from '../../src/messages/index.js';
import { collectIssues, validatePayload, type ActionSchema } from '../../src/rpc/index.js';

const boot = { chargePointVendor: 'Acme', chargePointModel: 'X1' };
const now = '2026-03-01T10:00:00.000Z';

describe('payload validation', () => {
  it('accepts valid payloads', () => {
    expect(validatePayload(BootNotificationRequest, boot)).toBeUndefined();
    expect(
      validatePayload(BootNotificationResponse, {
        status: 'Accepted',
        currentTime: now,
        interval: 60,
      }),
    ).toBeUndefined();
  });

  it('maps a missing required field to OccurenceConstraintViolation', () => {
    const error = validatePayload(BootNotificationRequest, { chargePointVendor: 'Acme' });
    expect(error?.code).toBe('OccurenceConstraintViolation');
    expect(error?.details).toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ path: '/chargePointModel' })]),
    });
  });

  it('maps a wrong JSON type to TypeConstraintViolation', () => {
    expect(validatePayload(BootNotificationRequest, { ...boot, chargePointModel: 42 })?.code).toBe(
      'TypeConstraintViolation',
    );
    expect(
      validatePayload(StartTransactionRequest, {
        connectorId: 1.5,
        idTag: 'A',
        meterStart: 0,
        timestamp: now,
      })?.code,
    ).toBe('TypeConstraintViolation');
  });

  it('maps an enum value of the right type to PropertyConstraintViolation', () => {
    const payload = { connectorId: 1, errorCode: 'NoError', status: 'Sleeping' };
    expect(validatePayload(StatusNotificationRequest, payload)?.code).toBe(
      'PropertyConstraintViolation',
    );
    expect(validatePayload(StatusNotificationRequest, { ...payload, status: 3 })?.code).toBe(
      'TypeConstraintViolation',
    );
  });

  it('maps length, range and pattern violations to PropertyConstraintViolation', () => {
    expect(
      validatePayload(BootNotificationRequest, { ...boot, chargePointVendor: 'x'.repeat(21) })
        ?.code,
    ).toBe('PropertyConstraintViolation');
    expect(
      validatePayload(StartTransactionRequest, {
        connectorId: 0,
        idTag: 'A',
        meterStart: 0,
        timestamp: now,
      })?.code,
    ).toBe('PropertyConstraintViolation');
    expect(
      validatePayload(StartTransactionRequest, {
        connectorId: 1,
        idTag: 'A',
        meterStart: 0,
        timestamp: '01/02/2026',
      })?.code,
    ).toBe('PropertyConstraintViolation');
  });

  it('maps an empty required array to OccurenceConstraintViolation', () => {
    expect(validatePayload(MeterValuesRequest, { connectorId: 1, meterValue: [] })?.code).toBe(
      'OccurenceConstraintViolation',
    );
  });

  it('maps undeclared properties to FormationViolation', () => {
    expect(validatePayload(BootNotificationRequest, { ...boot, colour: 'red' })?.code).toBe(
      'FormationViolation',
    );
  });

  it('prefers the most structural violation when several apply', () => {
    const error = validatePayload(BootNotificationRequest, {
      chargePointVendor: 1,
      extra: true,
    });
    expect(error?.code).toBe('FormationViolation');
    const issues = collectIssues(BootNotificationRequest, { chargePointVendor: 1, extra: true });
    expect(new Set(issues.map((issue) => issue.code))).toEqual(
      new Set(['FormationViolation', 'OccurenceConstraintViolation', 'TypeConstraintViolation']),
    );
  });

  it('validates nested structures such as charging profiles', () => {
    const profile = {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Relative',
        chargingSchedule: {
          chargingRateUnit: 'A',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }],
        },
      },
    };
    expect(validatePayload(SetChargingProfileRequest, profile)).toBeUndefined();
    const bad = structuredClone(profile);
    bad.csChargingProfiles.chargingSchedule.chargingRateUnit = 'kW';
    const error = validatePayload(SetChargingProfileRequest, bad);
    expect(error?.code).toBe('PropertyConstraintViolation');
    expect(error?.message).toContain('/csChargingProfiles/chargingSchedule/chargingRateUnit');
  });

  it('accepts date-times with offsets and fractional seconds but not local times', () => {
    const base = { connectorId: 1, idTag: 'A', meterStart: 0 };
    for (const timestamp of ['2026-03-01T10:00:00Z', '2026-03-01T10:00:00.123+02:00']) {
      expect(validatePayload(StartTransactionRequest, { ...base, timestamp })).toBeUndefined();
    }
    for (const timestamp of ['2026-03-01T10:00:00', '2026-13-01T10:00:00Z', '2026-03-01 10:00Z']) {
      expect(validatePayload(StartTransactionRequest, { ...base, timestamp })).toBeDefined();
    }
  });

  it('accepts TriggerMessage for connector 0, as the official schema and the spec prose do', () => {
    expect(
      validatePayload(TriggerMessageRequest, {
        requestedMessage: 'StatusNotification',
        connectorId: 0,
      }),
    ).toBeUndefined();
    expect(
      validatePayload(TriggerMessageRequest, { requestedMessage: 'MeterValues', connectorId: -1 })
        ?.code,
    ).toBe('PropertyConstraintViolation');
  });

  it('caps the number of reported issues', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const error = validatePayload(BootNotificationRequest, { ...boot, ...many });
    expect((error?.details.errors as unknown[]).length).toBe(10);
  });
});

describe('message catalogue', () => {
  it('covers the Core profile and Smart Charging in both directions', () => {
    expect(Object.keys(ChargePointToCentralSystem).sort()).toEqual([
      'Authorize',
      'BootNotification',
      'DataTransfer',
      'Heartbeat',
      'MeterValues',
      'StartTransaction',
      'StatusNotification',
      'StopTransaction',
    ]);
    expect(Object.keys(CentralSystemToChargePoint).sort()).toEqual([
      'ChangeAvailability',
      'ChangeConfiguration',
      'ClearCache',
      'ClearChargingProfile',
      'DataTransfer',
      'GetCompositeSchedule',
      'GetConfiguration',
      'RemoteStartTransaction',
      'RemoteStopTransaction',
      'Reset',
      'SetChargingProfile',
      'TriggerMessage',
      'UnlockConnector',
    ]);
  });

  it('forbids additional properties on every request and response object', () => {
    for (const map of [ChargePointToCentralSystem, CentralSystemToChargePoint]) {
      const entries: [string, ActionSchema][] = Object.entries(map);
      for (const [action, { request, response }] of entries) {
        expect(request.additionalProperties, `${action} request`).toBe(false);
        expect(response.additionalProperties, `${action} response`).toBe(false);
      }
    }
  });
});
