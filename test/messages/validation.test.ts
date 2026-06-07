import { describe, expect, it } from 'vitest';
import {
  ACTION_PROFILES,
  BootNotificationRequest,
  BootNotificationResponse,
  CancelReservationRequest,
  CentralSystemToChargePoint,
  ChargePointToCentralSystem,
  DiagnosticsStatusNotificationRequest,
  FEATURE_PROFILES,
  FirmwareStatusNotificationRequest,
  GetDiagnosticsRequest,
  GetDiagnosticsResponse,
  GetLocalListVersionResponse,
  MeterValuesRequest,
  ReserveNowRequest,
  ReserveNowResponse,
  SendLocalListRequest,
  SendLocalListResponse,
  SetChargingProfileRequest,
  StartTransactionRequest,
  StatusNotificationRequest,
  TriggerMessageRequest,
  UpdateFirmwareRequest,
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
  it('covers all 28 OCPP 1.6 messages in the right direction', () => {
    expect(Object.keys(ChargePointToCentralSystem).sort()).toEqual([
      'Authorize',
      'BootNotification',
      'DataTransfer',
      'DiagnosticsStatusNotification',
      'FirmwareStatusNotification',
      'Heartbeat',
      'MeterValues',
      'StartTransaction',
      'StatusNotification',
      'StopTransaction',
    ]);
    expect(Object.keys(CentralSystemToChargePoint).sort()).toEqual([
      'CancelReservation',
      'ChangeAvailability',
      'ChangeConfiguration',
      'ClearCache',
      'ClearChargingProfile',
      'DataTransfer',
      'GetCompositeSchedule',
      'GetConfiguration',
      'GetDiagnostics',
      'GetLocalListVersion',
      'RemoteStartTransaction',
      'RemoteStopTransaction',
      'ReserveNow',
      'Reset',
      'SendLocalList',
      'SetChargingProfile',
      'TriggerMessage',
      'UnlockConnector',
      'UpdateFirmware',
    ]);
    const all = new Set([
      ...Object.keys(ChargePointToCentralSystem),
      ...Object.keys(CentralSystemToChargePoint),
    ]);
    expect(all.size).toBe(28);
  });

  it('assigns every action to one of the six feature profiles', () => {
    const all = [
      ...new Set([
        ...Object.keys(ChargePointToCentralSystem),
        ...Object.keys(CentralSystemToChargePoint),
      ]),
    ].sort();
    expect(Object.keys(ACTION_PROFILES).sort()).toEqual(all);
    const counts = Object.fromEntries(FEATURE_PROFILES.map((profile) => [profile, 0]));
    for (const profile of Object.values(ACTION_PROFILES)) counts[profile]! += 1;
    expect(counts).toEqual({
      Core: 16,
      FirmwareManagement: 4,
      LocalAuthListManagement: 2,
      Reservation: 2,
      SmartCharging: 3,
      RemoteTrigger: 1,
    });
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

describe('Firmware Management, Local Auth List and Reservation PDUs', () => {
  it('validates firmware and diagnostics requests, including the location URI', () => {
    const update = { location: 'https://fw.example.com/acme-2.1.bin', retrieveDate: now };
    expect(validatePayload(UpdateFirmwareRequest, update)).toBeUndefined();
    expect(
      validatePayload(UpdateFirmwareRequest, { ...update, retries: 3, retryInterval: 30 }),
    ).toBeUndefined();
    expect(validatePayload(UpdateFirmwareRequest, { location: update.location })?.code).toBe(
      'OccurenceConstraintViolation',
    );
    for (const location of ['not a uri', '/relative/path', 'ftp:']) {
      expect(validatePayload(UpdateFirmwareRequest, { ...update, location })?.code).toBe(
        'PropertyConstraintViolation',
      );
    }
    expect(validatePayload(UpdateFirmwareRequest, { ...update, retries: -1 })?.code).toBe(
      'PropertyConstraintViolation',
    );
    expect(
      validatePayload(GetDiagnosticsRequest, {
        location: 'ftp://user:secret@logs.example.com/uploads/',
        startTime: now,
        stopTime: now,
      }),
    ).toBeUndefined();
    expect(validatePayload(GetDiagnosticsResponse, {})).toBeUndefined();
    expect(validatePayload(GetDiagnosticsResponse, { fileName: 'x'.repeat(256) })?.code).toBe(
      'PropertyConstraintViolation',
    );
    for (const status of [
      'Downloading',
      'Downloaded',
      'DownloadFailed',
      'Installing',
      'Installed',
      'InstallationFailed',
      'Idle',
    ]) {
      expect(validatePayload(FirmwareStatusNotificationRequest, { status })).toBeUndefined();
    }
    for (const status of ['Uploading', 'Uploaded', 'UploadFailed', 'Idle']) {
      expect(validatePayload(DiagnosticsStatusNotificationRequest, { status })).toBeUndefined();
    }
    expect(validatePayload(DiagnosticsStatusNotificationRequest, { status: 'Done' })?.code).toBe(
      'PropertyConstraintViolation',
    );
  });

  it('validates local list updates', () => {
    const full = {
      listVersion: 3,
      updateType: 'Full',
      localAuthorizationList: [
        { idTag: 'CARD-1', idTagInfo: { status: 'Accepted', parentIdTag: 'FLEET-A' } },
        { idTag: 'CARD-2', idTagInfo: { status: 'Blocked', expiryDate: now } },
      ],
    };
    expect(validatePayload(SendLocalListRequest, full)).toBeUndefined();
    expect(
      validatePayload(SendLocalListRequest, {
        listVersion: 4,
        updateType: 'Differential',
        localAuthorizationList: [{ idTag: 'CARD-2' }],
      }),
    ).toBeUndefined();
    expect(validatePayload(SendLocalListRequest, { ...full, updateType: 'Partial' })?.code).toBe(
      'PropertyConstraintViolation',
    );
    expect(validatePayload(GetLocalListVersionResponse, { listVersion: -1 })).toBeUndefined();
    expect(validatePayload(GetLocalListVersionResponse, { listVersion: -2 })?.code).toBe(
      'PropertyConstraintViolation',
    );
    expect(validatePayload(SendLocalListResponse, { status: 'VersionMismatch' })).toBeUndefined();
  });

  it('validates reservations, including connector 0', () => {
    const reservation = {
      connectorId: 0,
      expiryDate: now,
      idTag: 'CARD-1',
      parentIdTag: 'FLEET-A',
      reservationId: 17,
    };
    expect(validatePayload(ReserveNowRequest, reservation)).toBeUndefined();
    expect(
      validatePayload(ReserveNowRequest, { ...reservation, idTag: 'x'.repeat(21) })?.code,
    ).toBe('PropertyConstraintViolation');
    for (const status of ['Accepted', 'Faulted', 'Occupied', 'Rejected', 'Unavailable']) {
      expect(validatePayload(ReserveNowResponse, { status })).toBeUndefined();
    }
    expect(validatePayload(CancelReservationRequest, { reservationId: '17' })?.code).toBe(
      'TypeConstraintViolation',
    );
  });

  it('accepts StartTransaction with a reservationId', () => {
    expect(
      validatePayload(StartTransactionRequest, {
        connectorId: 1,
        idTag: 'CARD-1',
        meterStart: 0,
        reservationId: 17,
        timestamp: now,
      }),
    ).toBeUndefined();
  });

  it('accepts the unit spellings chargers use in the field', () => {
    for (const unit of ['Celcius', 'Celsius', 'Hertz']) {
      expect(
        validatePayload(MeterValuesRequest, {
          connectorId: 0,
          meterValue: [{ timestamp: now, sampledValue: [{ value: '1', unit }] }],
        }),
      ).toBeUndefined();
    }
  });
});
