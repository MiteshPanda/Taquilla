import type { Logger } from 'pino';
import type { Database } from '../db.js';

// Frees seats whose hold has lapsed (FR-EXP-3). Correctness never depends on it: every query
// already treats a lapsed hold as free. The sweeper only tidies up, so the seat map and the
// audit's 30-second rule (INV-4) see the seats as available.
//
// Ascending id order, as every transaction that locks seats uses (ADR 3). SKIP LOCKED steps past
// a seat a booking has locked, instead of waiting for it; the next run frees that one if it's
// still lapsed. It also lets two sweepers run at once without doing the same work (FR-EXP-4).
const FREE_LAPSED_SEATS = `
  WITH lapsed AS (
    SELECT id FROM seats
     WHERE status = 'held' AND held_until < now()
     ORDER BY id
     LIMIT $1
       FOR UPDATE SKIP LOCKED
  )
  UPDATE seats
     SET status = 'available', hold_id = NULL, held_until = NULL
    FROM lapsed
   WHERE seats.id = lapsed.id`;

// FR-EXP-5: a key is kept for 24 hours, long enough for any client to retry. After that, the
// same key is a new request; a repeated checkout then finds its order already paid and charges
// nothing. SKIP LOCKED steps past a key a request is saving at that moment.
export const KEY_TTL_HOURS = 24;

const DELETE_OLD_KEYS = `
  WITH old AS (
    SELECT user_id, idem_key FROM idempotency_keys
     WHERE locked_at < now() - make_interval(hours => $2)
     LIMIT $1
       FOR UPDATE SKIP LOCKED
  )
  DELETE FROM idempotency_keys AS keys
   USING old
   WHERE keys.user_id = old.user_id AND keys.idem_key = old.idem_key`;

export interface SweeperOptions {
  db: Pick<Database, 'withTransaction'>;
  logger: Logger;
  intervalMs: number;
  batchSize?: number;
}

export interface Sweeper {
  // Frees every lapsed seat, a batch per transaction. Returns how many it freed.
  sweepOnce(): Promise<number>;
  // Deletes every idempotency key older than KEY_TTL_HOURS, a batch per transaction.
  deleteOldKeys(): Promise<number>;
  // Runs now, then again intervalMs after each run ends, so two runs never overlap.
  start(): void;
  // Waits for a run in progress to finish, then schedules no more.
  stop(): Promise<void>;
}

export function createSweeper({
  db,
  logger,
  intervalMs,
  batchSize = 1_000,
}: SweeperOptions): Sweeper {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  // True from start() until stop(). stopRequested also cuts short a run's remaining batches.
  let scheduled = false;
  let stopRequested = false;

  function batch(sql: string, params: unknown[]): Promise<number> {
    return db.withTransaction(async (client) => {
      const { rowCount } = await client.query(sql, params);
      return rowCount ?? 0;
    });
  }

  // A full batch means there may be more, so keep going until one comes back short.
  async function drain(sql: string, params: unknown[]): Promise<number> {
    let total = 0;
    for (;;) {
      const done = await batch(sql, params);
      total += done;
      if (done < batchSize || stopRequested) return total;
    }
  }

  const sweepOnce = () => drain(FREE_LAPSED_SEATS, [batchSize]);
  const deleteOldKeys = () => drain(DELETE_OLD_KEYS, [batchSize, KEY_TTL_HOURS]);

  async function run(): Promise<void> {
    const startedAt = performance.now();
    try {
      const freed = await sweepOnce();
      // Seats first: they matter to fans now. A stop cuts the run short before the keys.
      const keysDeleted = stopRequested ? 0 : await deleteOldKeys();
      const durationMs = Math.round(performance.now() - startedAt);
      // Every run is logged, but a run with nothing to do only at debug, to keep the log readable.
      const level = freed > 0 || keysDeleted > 0 ? 'info' : 'debug';
      logger[level]({ freed, keysDeleted, durationMs }, 'sweep finished');
    } catch (err) {
      // A database outage mustn't stop the sweeper; the next run tries again.
      logger.error({ err }, 'sweep failed; trying again at the next interval');
    }
  }

  function schedule(delayMs: number): void {
    if (!scheduled) return;
    timer = setTimeout(() => {
      running = run().finally(() => {
        running = undefined;
        schedule(intervalMs);
      });
    }, delayMs);
  }

  return {
    sweepOnce,
    deleteOldKeys,

    start() {
      if (scheduled) return;
      scheduled = true;
      stopRequested = false;
      schedule(0);
    },

    async stop() {
      scheduled = false;
      stopRequested = true;
      clearTimeout(timer);
      await running;
    },
  };
}
