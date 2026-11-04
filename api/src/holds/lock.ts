import { assertEventExists, assertSeatsInEvent, seatsTaken, writeHold } from './shared.js';
import type { SeatRow } from './shared.js';
import type { HoldStrategy, StrategyOptions } from './strategy.js';

// The default strategy: lock the requested seats, decide while holding the locks, then write.
// Anyone else asking for the same seats waits at FOR UPDATE until this transaction commits, then
// re-reads the rows, sees them held and gets a clean 409.
export function createLockStrategy({ db, holdSeconds }: StrategyOptions): HoldStrategy {
  return {
    name: 'lock',

    hold: ({ userId, eventId, seatIds }) =>
      db.withTransaction(async (client) => {
        await assertEventExists(client, eventId);

        // Every transaction locks seats in ascending id order, so two holds that share seats
        // queue behind each other instead of deadlocking (FR-HOLD-6).
        const { rows: seats } = await client.query<SeatRow & { is_free: boolean }>(
          `SELECT id, price_paise,
                  status = 'available' OR (status = 'held' AND held_until < now()) AS is_free
             FROM seats
            WHERE event_id = $1 AND id = ANY($2::int[])
            ORDER BY id
              FOR UPDATE`,
          [eventId, seatIds],
        );

        assertSeatsInEvent(seatIds, seats);
        // A lapsed hold counts as free here, without waiting for the sweeper (lazy expiry).
        const taken = seats.filter((seat) => !seat.is_free).map((seat) => seat.id);
        if (taken.length > 0) throw seatsTaken(taken);

        return writeHold(client, { userId, eventId }, seats, holdSeconds);
      }),
  };
}
