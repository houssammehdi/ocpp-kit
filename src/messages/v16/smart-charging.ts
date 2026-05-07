/** Smart Charging profile PDUs, authored from the OCPP 1.6 specification. */
import { Type, type Static } from '@sinclair/typebox';
import {
  ChargingProfile,
  ChargingProfilePurpose,
  ChargingRateUnit,
  ChargingSchedule,
  ConnectorIdOrStation,
} from './datatypes.js';
import { DateTime, NonNegativeInteger, StringEnum, strict } from './primitives.js';

export const SetChargingProfileRequest = Type.Object(
  { connectorId: ConnectorIdOrStation, csChargingProfiles: ChargingProfile },
  strict,
);
export type SetChargingProfileRequest = Static<typeof SetChargingProfileRequest>;

export const ChargingProfileStatus = StringEnum(['Accepted', 'Rejected', 'NotSupported']);
export type ChargingProfileStatus = Static<typeof ChargingProfileStatus>;
export const SetChargingProfileResponse = Type.Object({ status: ChargingProfileStatus }, strict);
export type SetChargingProfileResponse = Static<typeof SetChargingProfileResponse>;

export const ClearChargingProfileRequest = Type.Object(
  {
    id: Type.Optional(Type.Integer()),
    connectorId: Type.Optional(ConnectorIdOrStation),
    chargingProfilePurpose: Type.Optional(ChargingProfilePurpose),
    stackLevel: Type.Optional(NonNegativeInteger()),
  },
  strict,
);
export type ClearChargingProfileRequest = Static<typeof ClearChargingProfileRequest>;

export const ClearChargingProfileStatus = StringEnum(['Accepted', 'Unknown']);
export type ClearChargingProfileStatus = Static<typeof ClearChargingProfileStatus>;
export const ClearChargingProfileResponse = Type.Object(
  { status: ClearChargingProfileStatus },
  strict,
);
export type ClearChargingProfileResponse = Static<typeof ClearChargingProfileResponse>;

export const GetCompositeScheduleRequest = Type.Object(
  {
    connectorId: ConnectorIdOrStation,
    duration: NonNegativeInteger('Length of the requested schedule in seconds'),
    chargingRateUnit: Type.Optional(ChargingRateUnit),
  },
  strict,
);
export type GetCompositeScheduleRequest = Static<typeof GetCompositeScheduleRequest>;

export const GetCompositeScheduleStatus = StringEnum(['Accepted', 'Rejected']);
export type GetCompositeScheduleStatus = Static<typeof GetCompositeScheduleStatus>;
export const GetCompositeScheduleResponse = Type.Object(
  {
    status: GetCompositeScheduleStatus,
    connectorId: Type.Optional(ConnectorIdOrStation),
    scheduleStart: Type.Optional(DateTime()),
    chargingSchedule: Type.Optional(ChargingSchedule),
  },
  strict,
);
export type GetCompositeScheduleResponse = Static<typeof GetCompositeScheduleResponse>;
