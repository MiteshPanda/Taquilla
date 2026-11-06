import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';
import type { Hold, HoldRequest } from './strategy.js';

// The parts every strategy shares: the same checks and the same answers, so only the way each
// one handles contention differs (FR-HOLD-5).

export interface SeatRow {
  id: number;
  price_paise: number;
}

// "Seat 42", "Seats 41 and 42", "Seats 1, 2 and 3".
export function describeSeats(seatIds: number[]): string {
  const [last, ...rest] = [...seatIds].reverse();
  if (rest.length === 0) return `Seat ${last}`;
  return `Seats ${rest.reverse().join(', ')} and ${last}`;
}

export function seatsTaken(seatIds: number[]): AppError {
  const many = seatIds.length > 1;
  return new AppError(
    409,
    'SEAT_TAKEN',
    `${describeSeats(seatIds)} ${many ? 'were' : 'was'} just taken. Pick ${many ? 'other seats' : 'another seat'}.`,
    { seatIds },
  );
}

export async function assertEventExists(client: PoolClient, eventId: number): Promise<void> {
  const { rowCount } = await client.query('SELECT 1 FROM events WHERE id = $1', [eventId]);
  if (rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'This event does not exist.');
  }
}

// A requested seat that the query didn't find either doesn't exist or belongs to another event.
export function assertSeatsInEvent(requested: number[], found: SeatRow[]): void {
  const foundIds = new Set(found.map((seat) => seat.id));
  const missing = requested.filter((id) => !foundIds.has(id)).sort((a, b) => a - b);
  if (missing.length > 0) {
    const many = missing.length > 1;
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      `${describeSeats(missing)} ${many ? 'are' : 'is'} not part of this event.`,
      { seatIds: missing },
    );
  }
}

// Records the hold itself, with its seats in ascending order and their total price.
export async function insertHold(
  client: PoolClient,
  { userId, eventId }: Omit<HoldRequest, 'seatIds'>,
  seats: SeatRow[],
): Promise<Omit<Hold, 'expiresAt'>> {
  const seatIds = seats.map((seat) => seat.id).sort((a, b) => a - b);
  const amountPaise = seats.reduce((sum, seat) => sum + seat.price_paise, 0);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO holds (user_id, event_id, seat_ids, amount_paise)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, eventId, seatIds, amountPaise],
  );
  const holdId = rows[0]?.id;
  if (holdId === undefined) throw new Error('INSERT … RETURNING returned no row.');
  return { holdId, seatIds, amountPaise };
}

// Records the hold and marks its seats held. Call it only once every seat is known to be free,
// inside the same transaction that decided so.
export async function writeHold(
  client: PoolClient,
  request: Omit<HoldRequest, 'seatIds'>,
  seats: SeatRow[],
  holdSeconds: number,
): Promise<Hold> {
  const { holdId, seatIds, amountPaise } = await insertHold(client, request, seats);

  // held_until comes back from Postgres, so the hold's expiry follows the database clock (DR-6).
  const { rows: held } = await client.query<{ held_until: Date }>(
    `UPDATE seats
        SET status = 'held', hold_id = $1, held_until = now() + make_interval(secs => $2::int)
      WHERE id = ANY($3::int[])
      RETURNING held_until`,
    [holdId, holdSeconds, seatIds],
  );
  const expiresAt = held[0]?.held_until;
  if (held.length !== seatIds.length || expiresAt === undefined) {
    throw new Error(`Expected to hold ${seatIds.length} seats, but held ${held.length}.`);
  }

  return { holdId, seatIds, amountPaise, expiresAt };
}
