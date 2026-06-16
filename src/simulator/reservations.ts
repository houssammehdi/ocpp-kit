import type { ReserveNowRequest } from '../messages/index.js';
import { sameGroup } from './authorization.js';

/** A reservation accepted through ReserveNow. */
export interface Reservation {
  readonly reservationId: number;
  /** Reserved connector, or 0 for "any connector of the charge point". */
  readonly connectorId: number;
  readonly idTag: string;
  readonly parentIdTag: string | undefined;
  readonly expiryDate: Date;
}

/** Create a {@link Reservation} from a ReserveNow request. */
export function reservationFrom(request: ReserveNowRequest): Reservation {
  return {
    reservationId: request.reservationId,
    connectorId: request.connectorId,
    idTag: request.idTag,
    parentIdTag: request.parentIdTag,
    expiryDate: new Date(request.expiryDate),
  };
}

/**
 * Whether an idTag may use a reservation. OCPP 1.6 section 5.13: a reserved connector refuses
 * every idTag "except when the incoming idTag or the parent idTag match the idTag or parent
 * idTag of the reservation". `parentIdTag` is the parent of the presented idTag, as found in the
 * Local Authorization List, the Authorization Cache or an Authorize.conf.
 */
export function matchesReservation(
  reservation: Reservation,
  idTag: string,
  parentIdTag: string | undefined,
): boolean {
  return sameGroup(
    { idTag, parentIdTag },
    { idTag: reservation.idTag, parentIdTag: reservation.parentIdTag },
  );
}

/** The reservations held by a charge point, keyed by reservationId. */
export class ReservationBook {
  readonly #reservations = new Map<number, Reservation>();

  /** Number of reservations. */
  get size(): number {
    return this.#reservations.size;
  }

  /** Reservation with this id, if any. */
  get(reservationId: number): Reservation | undefined {
    return this.#reservations.get(reservationId);
  }

  /** The reservation of a specific connector (not connector 0), if any. */
  forConnector(connectorId: number): Reservation | undefined {
    for (const reservation of this.#reservations.values()) {
      if (reservation.connectorId === connectorId) return reservation;
    }
    return undefined;
  }

  /** Reservations made for connector 0 ("any connector"). */
  stationWide(): Reservation[] {
    return [...this.#reservations.values()].filter((r) => r.connectorId === 0);
  }

  /** All reservations. */
  all(): Reservation[] {
    return [...this.#reservations.values()];
  }

  /** Add or replace a reservation. */
  add(reservation: Reservation): void {
    this.#reservations.set(reservation.reservationId, reservation);
  }

  /** Remove a reservation. Returns it when it existed. */
  remove(reservationId: number): Reservation | undefined {
    const reservation = this.#reservations.get(reservationId);
    this.#reservations.delete(reservationId);
    return reservation;
  }

  /** Remove and return the reservations whose expiryDate is not after `now`. */
  takeExpired(now: Date): Reservation[] {
    const expired = [...this.#reservations.values()].filter((r) => r.expiryDate <= now);
    for (const reservation of expired) this.#reservations.delete(reservation.reservationId);
    return expired;
  }
}
