import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedStadium } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth/tokens.js';
import { BOOKING_STRATEGIES } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { schemaConnectionString } from './helpers/database.js';
import { NO_PAYMENTS } from './helpers/payments.js';

// FR-HOLD-4: when many fans want the same seats at once, exactly one gets each seat and everyone
// else gets a 409, never a 5xx, under every strategy. Requests go through a real HTTP server with
// the API's pool of 20 connections, as in production.

const SCHEMA = 'concurrency_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'concurrency-secret-at-least-32-chars';
const FANS = 100;

const logger = createLogger('silent');
// One token per seeded fan, made up front so signing doesn't stagger the requests.
const tokens = Array.from({ length: FANS }, (_, i) => signToken(i + 1, JWT_SECRET, 3600));

interface Answer {
  status: number;
  code?: string;
  holdId?: string;
  seatIds?: number[];
}

let db: Database;

function countBy(answers: Answer[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { status, code } of answers) {
    const key = `${status} ${code ?? 'held'}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// The pool opens connections only when asked, one after another. Opening all 20 first makes the
// fans' transactions really overlap, instead of the first finishing before the rest connect.
async function openAllConnections(): Promise<void> {
  await Promise.all(Array.from({ length: 20 }, () => db.pool.query('SELECT pg_sleep(0.05)')));
}

// Which hold, if any, each seat belongs to now.
async function holderOf(seatIds: number[]): Promise<Map<number, string | null>> {
  const { rows } = await db.pool.query<{ id: number; hold_id: string | null }>(
    'SELECT id, hold_id FROM seats WHERE id = ANY($1::int[])',
    [seatIds],
  );
  return new Map(rows.map((row) => [row.id, row.hold_id]));
}

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

describe.each(BOOKING_STRATEGIES)('under the %s strategy', { timeout: 30_000 }, (name) => {
  let server: Server;
  let baseUrl: string;

  // Sends every request at once and collects each answer.
  async function holdAll(requests: { fan: number; seatIds: number[] }[]): Promise<Answer[]> {
    await openAllConnections();
    return Promise.all(
      requests.map(async ({ fan, seatIds }) => {
        const res = await fetch(`${baseUrl}/events/1/holds`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokens[fan % FANS]}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ seatIds }),
        });
        const body = (await res.json()) as {
          holdId?: string;
          seatIds?: number[];
          error?: { code: string };
        };
        return {
          status: res.status,
          code: body.error?.code,
          holdId: body.holdId,
          seatIds: body.seatIds,
        };
      }),
    );
  }

  beforeAll(async () => {
    const config = {
      NODE_ENV: 'test' as const,
      JWT_SECRET,
      JWT_EXPIRES_IN: 3600,
      RACE_DELAY_MS: 0,
    };
    const holdStrategy = createHoldStrategy(name, { db, holdSeconds: 300, logger });
    const app = createApp({
      config: { CORS_ORIGINS: [] },
      logger,
      routes: createRoutes({ db, config, holdStrategy, payments: NO_PAYMENTS }),
    });
    server = app.listen(0);
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('gives one seat to exactly 1 of 100 fans, and a 409 to the other 99', async () => {
    const answers = await holdAll(
      Array.from({ length: FANS }, (_, fan) => ({ fan, seatIds: [42] })),
    );

    const winners = answers.filter((answer) => answer.status === 201);
    expect(winners).toHaveLength(1);
    expect(answers.filter((answer) => answer.status === 409)).toHaveLength(99);
    // SEAT_TAKEN for most; serializable may also answer SEAT_BUSY once its retries run out.
    for (const loser of answers.filter((answer) => answer.status === 409)) {
      expect(['SEAT_TAKEN', 'SEAT_BUSY']).toContain(loser.code);
    }
    expect((await holderOf([42])).get(42)).toBe(winners[0]?.holdId);
    expect((await db.pool.query('SELECT 1 FROM holds')).rowCount).toBe(1);
    console.info(`${name}, one seat, 100 fans: ${JSON.stringify(countBy(answers))}`);
  });

  it('never answers 5xx when overlapping multi-seat holds ask in opposite orders', async () => {
    // Each pair asks for the same seats in reverse order, which is how two transactions deadlock
    // if they lock rows in the order they were asked for. Groups overlap, so fans also race across them.
    const patterns = [
      [101, 102, 103, 104],
      [104, 103, 102, 101],
      [105, 106, 107, 108],
      [108, 107, 106, 105],
      [104, 105],
      [105, 104],
    ];
    const answers = await holdAll(
      Array.from({ length: 60 }, (_, fan) => ({
        fan,
        seatIds: patterns[fan % patterns.length] ?? [],
      })),
    );

    expect(answers.filter((answer) => answer.status !== 201 && answer.status !== 409)).toEqual([]);
    const winners = answers.filter((answer) => answer.status === 201);
    expect(winners.length).toBeGreaterThan(0);

    // No seat went to two winners, and every winner really has every seat it was told it holds.
    const won = winners.flatMap((winner) => winner.seatIds ?? []);
    expect(new Set(won).size).toBe(won.length);
    const holders = await holderOf([101, 102, 103, 104, 105, 106, 107, 108]);
    for (const winner of winners) {
      for (const seatId of winner.seatIds ?? []) expect(holders.get(seatId)).toBe(winner.holdId);
    }
    expect((await db.pool.query('SELECT 1 FROM holds')).rowCount).toBe(winners.length);
    // FR-HOLD-6: lock takes its row locks in ascending id order, so opposite orders only ever queue.
    // A deadlock or a lock wait past the timeout would show up here as SEAT_BUSY.
    if (name === 'lock') {
      expect(answers.filter((answer) => answer.code === 'SEAT_BUSY')).toEqual([]);
    }
    console.info(`${name}, opposite orders, 60 fans: ${JSON.stringify(countBy(answers))}`);
  });

  it('holds all four seats or none of them when one is being taken at the same moment', async () => {
    // 25 groups of four seats. In each, one fan asks for all four while another asks for the last
    // one alone, all 50 requests at once.
    const groups = Array.from({ length: 25 }, (_, g) =>
      [301, 302, 303, 304].map((seat) => seat + g * 4),
    );
    const answers = await holdAll(
      groups.flatMap((seats, g) => [
        { fan: 2 * g, seatIds: seats },
        { fan: 2 * g + 1, seatIds: seats.slice(3) },
      ]),
    );

    expect(answers.filter((answer) => answer.status !== 201 && answer.status !== 409)).toEqual([]);
    const holders = await holderOf(groups.flat());
    let decided = 0;
    groups.forEach((seats, g) => {
      const all = answers[2 * g];
      const last = answers[2 * g + 1];
      expect(all?.status === 201 && last?.status === 201).toBe(false);
      if (all?.status === 201) {
        for (const seat of seats) expect(holders.get(seat)).toBe(all.holdId);
      } else {
        // The four-seat hold lost, so none of its first three seats may be held.
        for (const seat of seats.slice(0, 3)) expect(holders.get(seat)).toBeNull();
        expect(holders.get(seats[3] ?? 0)).toBe(last?.status === 201 ? last.holdId : null);
      }
      if (all?.status === 201 || last?.status === 201) decided += 1;
    });
    expect(decided).toBeGreaterThan(0);
    console.info(`${name}, all or nothing, 25 groups: ${JSON.stringify(countBy(answers))}`);
  });
});
