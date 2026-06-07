/** Reservation profile PDUs, written by hand from the OCPP 1.6 specification. */
import { Type, type Static } from '@sinclair/typebox';
import { ConnectorIdOrStation, IdToken } from './datatypes.js';
import { DateTime, StringEnum, strict } from './primitives.js';

/** Outcome of ReserveNow. */
export const ReservationStatus = StringEnum([
  'Accepted',
  'Faulted',
  'Occupied',
  'Rejected',
  'Unavailable',
]);
/** Outcome of ReserveNow. */
export type ReservationStatus = Static<typeof ReservationStatus>;

/** Outcome of CancelReservation. */
export const CancelReservationStatus = StringEnum(['Accepted', 'Rejected']);
/** Outcome of CancelReservation. */
export type CancelReservationStatus = Static<typeof CancelReservationStatus>;

/**
 * ReserveNow.req: keep a connector (or, for connector 0, any connector) free for `idTag` or any
 * idTag with the same `parentIdTag` until `expiryDate`. A request with the id of an existing
 * reservation replaces it.
 */
export const ReserveNowRequest = Type.Object(
  {
    connectorId: ConnectorIdOrStation,
    expiryDate: DateTime(),
    idTag: IdToken,
    parentIdTag: Type.Optional(IdToken),
    reservationId: Type.Integer(),
  },
  strict,
);
/** ReserveNow.req payload. */
export type ReserveNowRequest = Static<typeof ReserveNowRequest>;
/** ReserveNow.conf. */
export const ReserveNowResponse = Type.Object({ status: ReservationStatus }, strict);
/** ReserveNow.conf payload. */
export type ReserveNowResponse = Static<typeof ReserveNowResponse>;

/** CancelReservation.req. */
export const CancelReservationRequest = Type.Object({ reservationId: Type.Integer() }, strict);
/** CancelReservation.req payload. */
export type CancelReservationRequest = Static<typeof CancelReservationRequest>;
/** CancelReservation.conf. */
export const CancelReservationResponse = Type.Object({ status: CancelReservationStatus }, strict);
/** CancelReservation.conf payload. */
export type CancelReservationResponse = Static<typeof CancelReservationResponse>;
