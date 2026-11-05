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

export interface SweeperOptions {
  db: Pick<Database, 'withTransaction'>;
  logger: Logger;
  intervalMs: number;
  batchSize?: number;
}

export interface Sweeper {
  // One run: frees every lapsed seat, a batch per transaction. Returns how many it freed.
  sweepOnce(): Promise<number>;
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

  function sweepBatch(): Promise<number> {
    return db.withTransaction(async (client) => {
      const { rowCount } = await client.query(FREE_LAPSED_SEATS, [batchSize]);
      return rowCount ?? 0;
    });
  }

  async function sweepOnce(): Promise<number> {
    let freed = 0;
    // A full batch means there may be more, so keep going until one comes back short.
    for (;;) {
      const batch = await sweepBatch();
      freed += batch;
      if (batch < batchSize || stopRequested) return freed;
    }
  }

  async function run(): Promise<void> {
    const startedAt = performance.now();
    try {
      const freed = await sweepOnce();
      const durationMs = Math.round(performance.now() - startedAt);
      // Every run is logged, but a run with nothing to do only at debug, to keep the log readable.
      logger[freed > 0 ? 'info' : 'debug']({ freed, durationMs }, 'sweep finished');
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
