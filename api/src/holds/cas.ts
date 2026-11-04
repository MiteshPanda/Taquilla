import { assertEventExists, assertSeatsInEvent, insertHold, seatsTaken } from './shared.js';
import type { SeatRow } from './shared.js';
import type { HoldStrategy, StrategyOptions } from './strategy.js';

// Compare-and-set: one conditional UPDATE that only changes seats still free when it reaches
// them. There is no separate check to race against. If another transaction changed a seat first,
// Postgres waits for it, re-checks the condition on the new row and skips the seat, so two fans
// can never both take it. If fewer seats come back than were asked for, the whole hold rolls back.
export function createCasStrategy({ db, holdSeconds }: StrategyOptions): HoldStrategy {
  return {
    name: 'cas',

    hold: ({ userId, eventId, seatIds }) =>
      db.withTransaction(async (client) => {
        await assertEventExists(client, eventId);

        // Reads prices to record the hold, and finds seats outside the event. It decides nothing:
        // the UPDATE below does, so this read takes no locks.
        const { rows: seats } = await client.query<SeatRow>(
          `SELECT id, price_paise
             FROM seats
            WHERE event_id = $1 AND id = ANY($2::int[])
            ORDER BY id`,
          [eventId, seatIds],
        );
        assertSeatsInEvent(seatIds, seats);

        const { holdId, amountPaise } = await insertHold(client, { userId, eventId }, seats);

        // A lapsed hold counts as free here, without waiting for the sweeper (lazy expiry).
        const { rows: held } = await client.query<{ id: number; held_until: Date }>(
          `UPDATE seats
              SET status = 'held', hold_id = $1, held_until = now() + make_interval(secs => $2::int)
            WHERE event_id = $3
              AND id = ANY($4::int[])
              AND (status = 'available' OR (status = 'held' AND held_until < now()))
            RETURNING id, held_until`,
          [holdId, holdSeconds, eventId, seatIds],
        );

        const heldIds = new Set(held.map((seat) => seat.id));
        const taken = seats.map((seat) => seat.id).filter((id) => !heldIds.has(id));
        // Throwing rolls back the hold row and any seats this UPDATE did change (FR-HOLD-3).
        if (taken.length > 0) throw seatsTaken(taken);

        const expiresAt = held[0]?.held_until;
        if (expiresAt === undefined) throw new Error('UPDATE … RETURNING returned no row.');
        return { holdId, seatIds: seats.map((seat) => seat.id), amountPaise, expiresAt };
      }),
  };
}
