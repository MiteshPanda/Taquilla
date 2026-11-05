import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedStadium } from '../../scripts/seed.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth/tokens.js';
import { BOOKING_STRATEGIES } from '../src/config.js';
import type { BookingStrategy } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import { createSweeper } from '../src/jobs/sweeper.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { schemaConnectionString } from './helpers/database.js';

// FR-EXP-1 to FR-EXP-4 and INV-4: a hold ends on time without waiting for anything. A lapsed seat
// is free to the next fan at once, and the sweeper tidies up after, never undoing a newer hold.
// Only the end-to-end test waits for a real 2-second hold; everything else writes held_until in
// the past, so it doesn't depend on timing.

const SCHEMA = 'expiry_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'expiry-test-secret-at-least-32-chars';
const FAN = 1;
const RIVAL = 2;
const SEATS = 2_000;

const logger = createLogger('silent');
let db: Database;

function auth(userId: number): string {
  return `Bearer ${signToken(userId, JWT_SECRET, 3600)}`;
}

function appFor(strategy: BookingStrategy, holdSeconds: number) {
  const config = { NODE_ENV: 'test' as const, JWT_SECRET, JWT_EXPIRES_IN: 3600, RACE_DELAY_MS: 0 };
  const holdStrategy = createHoldStrategy(strategy, { db, holdSeconds, logger });
  return createApp({
    config: { CORS_ORIGINS: [] },
    logger,
    routes: createRoutes({ db, config, holdStrategy }),
  });
}

// Holds seats for one fan with a hold that lapsed `ago` (or lapses later, if negative).
async function lapsedHold(seatIds: number[], ago = '1 second', userId = FAN): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO holds (user_id, event_id, seat_ids, amount_paise) VALUES ($1, 1, $2, 1) RETURNING id`,
    [userId, seatIds.slice(0, 6)],
  );
  const holdId = rows[0]?.id ?? '';
  await db.pool.query(
    `UPDATE seats SET status = 'held', hold_id = $1, held_until = now() - $2::interval
      WHERE id = ANY($3::int[])`,
    [holdId, ago, seatIds],
  );
  return holdId;
}

async function seatRows(seatIds: number[]) {
  const { rows } = await db.pool.query<{ id: number; status: string; hold_id: string | null }>(
    'SELECT id, status, hold_id FROM seats WHERE id = ANY($1::int[]) ORDER BY id',
    [seatIds],
  );
  return rows;
}

// The audit's rule 4 (INV-4): seats still marked held more than 30 seconds after they lapsed.
async function staleHolds(): Promise<number> {
  const { rows } = await db.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM seats
      WHERE status = 'held' AND held_until < now() - interval '30 seconds'`,
  );
  return rows[0]?.count ?? -1;
}

async function mapState(app: ReturnType<typeof createApp>, seatId: number): Promise<string> {
  const res = await request(app).get('/events/1/seats').expect(200);
  const seat = (res.body as { seats: { id: number; state: string }[] }).seats.find(
    (candidate) => candidate.id === seatId,
  );
  return seat?.state ?? 'missing';
}

const allSeats = Array.from({ length: SEATS }, (_, i) => i + 1);

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
});

beforeEach(async () => {
  await db.pool.query(
    `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
      WHERE status <> 'available'`,
  );
  await db.pool.query('DELETE FROM holds');
});

afterAll(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('end to end, with HOLD_SECONDS=2', { timeout: 20_000 }, () => {
  it('a hold lasts 2 seconds, then its seats are free to others at once, and the sweeper tidies up', async () => {
    const app = appFor('lock', 2);
    const sweeper = createSweeper({ db, logger, intervalMs: 250 });

    const res = await request(app)
      .post('/events/1/holds')
      .set('Authorization', auth(FAN))
      .send({ seatIds: [41, 42] })
      .expect(201);
    const { expiresAt } = res.body as { expiresAt: string };

    // FR-EXP-1: it lasts HOLD_SECONDS, by the database's clock.
    const lifetimeMs = new Date(expiresAt).getTime() - Date.now();
    expect(lifetimeMs).toBeGreaterThan(1_000);
    expect(lifetimeMs).toBeLessThanOrEqual(2_500);
    await request(app)
      .post('/events/1/holds')
      .set('Authorization', auth(RIVAL))
      .send({ seatIds: [42] })
      .expect(409);

    await sleep(new Date(expiresAt).getTime() - Date.now() + 300);

    // FR-EXP-2: lapsed, and nothing has swept yet. The rows still say held, yet the map shows the
    // seat free and the rival can take it straight away.
    expect((await seatRows([41, 42])).map((seat) => seat.status)).toEqual(['held', 'held']);
    expect(await mapState(app, 41)).toBe('available');
    const rival = await request(app)
      .post('/events/1/holds')
      .set('Authorization', auth(RIVAL))
      .send({ seatIds: [42] })
      .expect(201);

    // FR-EXP-3: the sweeper frees the seat nobody took, and leaves the rival's new hold alone.
    sweeper.start();
    try {
      const deadline = Date.now() + 5_000;
      while ((await seatRows([41]))[0]?.status !== 'available') {
        if (Date.now() > deadline) throw new Error('The sweeper did not free seat 41.');
        await sleep(50);
      }
    } finally {
      await sweeper.stop();
    }
    expect(await seatRows([41, 42])).toEqual([
      { id: 41, status: 'available', hold_id: null },
      { id: 42, status: 'held', hold_id: (rival.body as { holdId: string }).holdId },
    ]);
  });
});

describe.each(BOOKING_STRATEGIES)('a lapsed seat, under the %s strategy', (strategy) => {
  it('can be held by another fan before any sweep runs', async () => {
    await lapsedHold([41, 42]);
    const app = appFor(strategy, 300);

    const res = await request(app)
      .post('/events/1/holds')
      .set('Authorization', auth(RIVAL))
      .send({ seatIds: [41, 42] })
      .expect(201);

    expect((await seatRows([41, 42])).map((seat) => seat.hold_id)).toEqual([
      (res.body as { holdId: string }).holdId,
      (res.body as { holdId: string }).holdId,
    ]);
  });

  it('is never wiped by a sweeper running while fans take it', async () => {
    // 20 lapsed seats; 20 fans each take one while a sweep runs at the same moment.
    const seatIds = Array.from({ length: 20 }, (_, i) => 101 + i);
    const lapsedHoldId = await lapsedHold(seatIds);
    const app = appFor(strategy, 300);
    const sweeper = createSweeper({ db, logger, intervalMs: 1_000 });

    // The sweeper sweeps again and again until every fan has an answer, so its runs really
    // overlap the fans' transactions instead of finishing before the first request arrives.
    let fansDone = false;
    const sweeping = (async () => {
      while (!fansDone) await sweeper.sweepOnce();
    })();
    const responses = await Promise.all(
      seatIds.map((seatId, i) =>
        request(app)
          .post('/events/1/holds')
          .set('Authorization', auth(10 + i))
          .send({ seatIds: [seatId] }),
      ),
    );
    fansDone = true;
    await sweeping;

    // Every seat was free to take, so lock and cas give every fan theirs. serializable may also
    // answer SEAT_BUSY when its retries run out, with this many transactions writing at once.
    const allowed = strategy === 'serializable' ? [201, 'SEAT_BUSY'] : [201];
    const answers = responses.map(
      (res) => (res.body as { error?: { code: string } }).error?.code ?? res.status,
    );
    for (const answer of answers) expect(allowed).toContain(answer);

    // The point of the test: a fan who won still has the seat, so the sweep undid no new hold.
    // A seat whose fan got SEAT_BUSY is either swept or still on the lapsed hold, never taken.
    const seats = await seatRows(seatIds);
    seats.forEach((seat, i) => {
      if (answers[i] === 201) {
        expect(seat).toEqual({
          id: seatIds[i],
          status: 'held',
          hold_id: (responses[i]?.body as { holdId: string }).holdId,
        });
      } else {
        expect([null, lapsedHoldId]).toContain(seat.hold_id);
      }
    });
  });
});

describe('a sweep under way while a fan takes a lapsed seat', () => {
  it('never undoes the new hold', async () => {
    const lapsedHoldId = await lapsedHold([101]);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO holds (user_id, event_id, seat_ids, amount_paise) VALUES ($1, 1, '{101}', 1) RETURNING id`,
      [RIVAL],
    );
    const newHoldId = rows[0]?.id ?? '';
    const fan = new Client({ connectionString: CONNECTION_STRING });
    await fan.connect();
    try {
      // The fan's transaction has locked the lapsed seat, as every strategy does before taking it.
      await fan.query('BEGIN');
      await fan.query('SELECT 1 FROM seats WHERE id = 101 FOR UPDATE');

      // A sweep starts now. A sweeper that waited for the lock would see the seat as lapsed
      // when it began, then free it after the fan commits, wiping the new hold.
      const sweep = createSweeper({ db, logger, intervalMs: 1_000 }).sweepOnce();
      await sleep(200);
      await fan.query(
        `UPDATE seats SET hold_id = $1, held_until = now() + interval '5 minutes' WHERE id = 101`,
        [newHoldId],
      );
      await fan.query('COMMIT');
      await sweep;
    } finally {
      await fan.end();
    }

    expect(await seatRows([101])).toEqual([{ id: 101, status: 'held', hold_id: newHoldId }]);
    expect(newHoldId).not.toBe(lapsedHoldId);
  });
});

describe('the sweeper over the whole stadium', () => {
  it('frees every lapsed seat in one sweep, and none of the live ones', async () => {
    // All 2,000 seats lapsed except 300 still live: two batches' worth for one run.
    const live = allSeats.slice(0, 300);
    await lapsedHold(allSeats.slice(300));
    await lapsedHold(live, '-5 minutes');

    const freed = await createSweeper({ db, logger, intervalMs: 1_000 }).sweepOnce();

    expect(freed).toBe(1_700);
    const { rows } = await db.pool.query<{ status: string; count: number }>(
      'SELECT status, count(*)::int AS count FROM seats GROUP BY status ORDER BY status',
    );
    expect(rows).toEqual([
      { status: 'available', count: 1_700 },
      { status: 'held', count: 300 },
    ]);
    expect(await staleHolds()).toBe(0);
  });

  it('frees each seat exactly once when four sweepers run at the same time (FR-EXP-4)', async () => {
    await lapsedHold(allSeats, '1 minute');
    expect(await staleHolds()).toBe(SEATS);
    // Separate pools, so the four really run side by side, in small batches so their work interleaves.
    const pools = Array.from({ length: 4 }, () =>
      createDatabase({ connectionString: CONNECTION_STRING, logger, max: 1 }),
    );
    try {
      const freed = await Promise.all(
        pools.map((pool) =>
          createSweeper({ db: pool, logger, intervalMs: 1_000, batchSize: 50 }).sweepOnce(),
        ),
      );

      // A seat freed twice would make the total come out above 2,000.
      expect(freed.reduce((sum, count) => sum + count, 0)).toBe(SEATS);
      expect((await seatRows(allSeats)).every((seat) => seat.status === 'available')).toBe(true);
      expect(await staleHolds()).toBe(0);
    } finally {
      await Promise.all(pools.map((pool) => pool.close()));
    }
  });
});
