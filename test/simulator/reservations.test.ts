import { describe, expect, it } from 'vitest';
import { matchesReservation, ReservationBook, reservationFrom } from '../../src/index.js';

const reservation = (reservationId: number, connectorId: number, expiry: string) =>
  reservationFrom({
    reservationId,
    connectorId,
    idTag: `CARD-${reservationId}`,
    parentIdTag: 'FLEET',
    expiryDate: expiry,
  });

describe('ReservationBook', () => {
  it('stores reservations by id and by connector', () => {
    const book = new ReservationBook();
    book.add(reservation(1, 2, '2026-05-01T13:00:00Z'));
    book.add(reservation(2, 0, '2026-05-01T14:00:00Z'));
    expect(book.size).toBe(2);
    expect(book.forConnector(2)?.reservationId).toBe(1);
    expect(book.forConnector(1)).toBeUndefined();
    expect(book.stationWide().map((r) => r.reservationId)).toEqual([2]);
    // Adding with an existing id replaces the reservation.
    book.add(reservation(1, 1, '2026-05-01T13:00:00Z'));
    expect(book.forConnector(1)?.reservationId).toBe(1);
    expect(book.forConnector(2)).toBeUndefined();
    expect(book.remove(1)?.connectorId).toBe(1);
    expect(book.remove(1)).toBeUndefined();
  });

  it('hands out the reservations that expired', () => {
    const book = new ReservationBook();
    book.add(reservation(1, 1, '2026-05-01T12:00:00Z'));
    book.add(reservation(2, 2, '2026-05-01T12:00:01Z'));
    const expired = book.takeExpired(new Date('2026-05-01T12:00:00Z'));
    expect(expired.map((r) => r.reservationId)).toEqual([1]);
    expect(book.all().map((r) => r.reservationId)).toEqual([2]);
  });
});

describe('matchesReservation', () => {
  it('accepts the reserved idTag or any idTag of the same parent group', () => {
    const r = reservation(1, 1, '2026-05-01T13:00:00Z');
    expect(matchesReservation(r, 'card-1', undefined)).toBe(true);
    expect(matchesReservation(r, 'OTHER', 'fleet')).toBe(true);
    expect(matchesReservation(r, 'OTHER', 'ELSEWHERE')).toBe(false);
    expect(matchesReservation(r, 'OTHER', undefined)).toBe(false);
  });
});
