/** Smart Charging profile PDUs, written by hand from the OCPP 1.6 specification. */
import { Type, type Static } from '@sinclair/typebox';
import {
  ChargingProfile,
  ChargingProfilePurpose,
  ChargingRateUnit,
  ChargingSchedule,
  ConnectorIdOrStation,
} from './datatypes.js';
import { DateTime, NonNegativeInteger, StringEnum, strict } from './primitives.js';

/** SetChargingProfile.req: install a profile on a connector (0: the charge point). */
export const SetChargingProfileRequest = Type.Object(
  { connectorId: ConnectorIdOrStation, csChargingProfiles: ChargingProfile },
  strict,
);
/** SetChargingProfile.req payload. */
export type SetChargingProfileRequest = Static<typeof SetChargingProfileRequest>;

/** Outcome of SetChargingProfile. */
export const ChargingProfileStatus = StringEnum(['Accepted', 'Rejected', 'NotSupported']);
/** Outcome of SetChargingProfile. */
export type ChargingProfileStatus = Static<typeof ChargingProfileStatus>;
/** SetChargingProfile.conf. */
export const SetChargingProfileResponse = Type.Object({ status: ChargingProfileStatus }, strict);
/** SetChargingProfile.conf payload. */
export type SetChargingProfileResponse = Static<typeof SetChargingProfileResponse>;

/**
 * ClearChargingProfile.req: clear one profile by `id`, or every profile matching all of the
 * other given criteria (no criteria: all profiles).
 */
export const ClearChargingProfileRequest = Type.Object(
  {
    id: Type.Optional(Type.Integer()),
    connectorId: Type.Optional(ConnectorIdOrStation),
    chargingProfilePurpose: Type.Optional(ChargingProfilePurpose),
    stackLevel: Type.Optional(NonNegativeInteger()),
  },
  strict,
);
/** ClearChargingProfile.req payload. */
export type ClearChargingProfileRequest = Static<typeof ClearChargingProfileRequest>;

/** Outcome of ClearChargingProfile; `Unknown` when nothing matched. */
export const ClearChargingProfileStatus = StringEnum(['Accepted', 'Unknown']);
/** Outcome of ClearChargingProfile. */
export type ClearChargingProfileStatus = Static<typeof ClearChargingProfileStatus>;
/** ClearChargingProfile.conf. */
export const ClearChargingProfileResponse = Type.Object(
  { status: ClearChargingProfileStatus },
  strict,
);
/** ClearChargingProfile.conf payload. */
export type ClearChargingProfileResponse = Static<typeof ClearChargingProfileResponse>;

/** GetCompositeSchedule.req: the effective limit on a connector for the next `duration` s. */
export const GetCompositeScheduleRequest = Type.Object(
  {
    connectorId: ConnectorIdOrStation,
    duration: NonNegativeInteger('Length of the requested schedule in seconds'),
    chargingRateUnit: Type.Optional(ChargingRateUnit),
  },
  strict,
);
/** GetCompositeSchedule.req payload. */
export type GetCompositeScheduleRequest = Static<typeof GetCompositeScheduleRequest>;

/** Outcome of GetCompositeSchedule. */
export const GetCompositeScheduleStatus = StringEnum(['Accepted', 'Rejected']);
/** Outcome of GetCompositeSchedule. */
export type GetCompositeScheduleStatus = Static<typeof GetCompositeScheduleStatus>;
/** GetCompositeSchedule.conf. */
export const GetCompositeScheduleResponse = Type.Object(
  {
    status: GetCompositeScheduleStatus,
    connectorId: Type.Optional(ConnectorIdOrStation),
    scheduleStart: Type.Optional(DateTime()),
    chargingSchedule: Type.Optional(ChargingSchedule),
  },
  strict,
);
/** GetCompositeSchedule.conf payload. */
export type GetCompositeScheduleResponse = Static<typeof GetCompositeScheduleResponse>;
