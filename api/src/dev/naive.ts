import { setTimeout as sleep } from 'node:timers/promises';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';

// Wrong on purpose, for demos and benchmarks (FR-DEV-1). It checks the seat and then writes, as
// separate statements with no lock and no transaction. Every request that reads the seat before
// the first write lands believes it is free, so one seat can be sold many times.
// Returns the naive ticket's id.
export async function buyNaive(
  db: Pick<Database, 'pool'>,
  userId: number,
  seatId: number,
  raceDelayMs: number,
): Promise<number> {
  const { rows } = await db.pool.query<{ status: string }>(
    'SELECT status FROM seats WHERE id = $1',
    [seatId],
  );
  const seat = rows[0];
  if (seat === undefined) {
    throw new AppError(404, 'NOT_FOUND', 'This seat does not exist.');
  }
  if (seat.status !== 'available') {
    throw new AppError(409, 'SEAT_TAKEN', `Seat ${seatId} was just taken. Pick another seat.`, {
      seatIds: [seatId],
    });
  }

  // Widens the gap between the check and the write, so the race is easy to see (FR-DEV-2).
  if (raceDelayMs > 0) await sleep(raceDelayMs);

  // Clearing the hold columns only keeps the seat's CHECK constraint satisfied. The bug is the gap.
  await db.pool.query(
    `UPDATE seats SET status = 'sold', hold_id = NULL, held_until = NULL WHERE id = $1`,
    [seatId],
  );
  const { rows: tickets } = await db.pool.query<{ id: number }>(
    'INSERT INTO naive_tickets (seat_id, user_id) VALUES ($1, $2) RETURNING id',
    [seatId, userId],
  );
  const ticket = tickets[0];
  if (ticket === undefined) throw new Error('INSERT … RETURNING returned no row.');
  return ticket.id;
}
