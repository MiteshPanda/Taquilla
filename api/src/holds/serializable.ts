import { retrySerializationFailures } from './retry.js';
import { assertEventExists, assertSeatsInEvent, seatsTaken, writeHold } from './shared.js';
import type { SeatRow } from './shared.js';
import type { HoldStrategy, StrategyOptions } from './strategy.js';

// The naive check-then-act, with no row locks, made safe by running it under SERIALIZABLE.
// When two transactions read the same free seat and both try to take it, Postgres aborts one with
// a serialization failure. The retry re-reads the seat, finds it held and answers 409. Correct,
// but contention costs aborted work, which the benchmarks in M6 measure.
export function createSerializableStrategy({
  db,
  holdSeconds,
  logger,
}: StrategyOptions): HoldStrategy {
  return {
    name: 'serializable',

    hold: ({ userId, eventId, seatIds }) =>
      retrySerializationFailures(
        () =>
          db.withTransaction(
            async (client) => {
              await assertEventExists(client, eventId);

              const { rows: seats } = await client.query<SeatRow & { is_free: boolean }>(
                `SELECT id, price_paise,
                        status = 'available' OR (status = 'held' AND held_until < now()) AS is_free
                   FROM seats
                  WHERE event_id = $1 AND id = ANY($2::int[])
                  ORDER BY id`,
                [eventId, seatIds],
              );

              assertSeatsInEvent(seatIds, seats);
              const taken = seats.filter((seat) => !seat.is_free).map((seat) => seat.id);
              if (taken.length > 0) throw seatsTaken(taken);

              return writeHold(client, { userId, eventId }, seats, holdSeconds);
            },
            { isolation: 'serializable' },
          ),
        { logger },
      ),
  };
}
