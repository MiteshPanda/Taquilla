import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedStadium } from '../../scripts/seed.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth/tokens.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { schemaConnectionString } from './helpers/database.js';

// FR-DEV-1: the naive buy checks a seat and then writes, so parallel buyers can all pass the check.
// This file keeps that bug on record. The it.fails test states the rule the naive buy breaks: it
// passes while the bug is there, and turns CI red if the naive buy ever stops overselling.

const SCHEMA = 'race_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'race-test-secret-at-least-32-characters';
const SEAT_ID = 42;
const BUYERS = 100;
// Without a delay, whether the requests overlap depends on the machine: a laptop with Postgres in
// Docker oversold 60 to 100 times, but GitHub's Linux runner finished each buy before the next one
// arrived and sold the seat once. A 50 ms gap oversold on both, every run, so it carries the proof.
const PROOF_DELAY_MS = 50;

const logger = createLogger('silent');
// One token per seeded fan, made up front so signing doesn't stagger the requests.
const tokens = Array.from({ length: BUYERS }, (_, i) => signToken(i + 1, JWT_SECRET, 3600));

interface RaceResult {
  statuses: number[];
  tickets: number;
  buyers: number;
}

let db: Database;

// Starts a real HTTP server, as in production, and fires every buyer at seat 42 at once.
async function race(raceDelayMs: number): Promise<RaceResult> {
  await db.pool.query('TRUNCATE naive_tickets');
  await db.pool.query(`UPDATE seats SET status = 'available' WHERE id = $1`, [SEAT_ID]);

  const config = {
    NODE_ENV: 'test' as const,
    JWT_SECRET,
    JWT_EXPIRES_IN: 3600,
    RACE_DELAY_MS: raceDelayMs,
  };
  const app = createApp({
    config: { CORS_ORIGINS: [] },
    logger,
    routes: createRoutes({ db, config }),
  });
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  try {
    const statuses = await Promise.all(
      tokens.map(async (token) => {
        const res = await fetch(`http://127.0.0.1:${port}/dev/buy-naive`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ seatId: SEAT_ID }),
        });
        await res.arrayBuffer();
        return res.status;
      }),
    );
    const { rows } = await db.pool.query<{ tickets: number; buyers: number }>(
      `SELECT count(*)::int AS tickets, count(DISTINCT user_id)::int AS buyers
         FROM naive_tickets WHERE seat_id = $1`,
      [SEAT_ID],
    );
    return { statuses, tickets: rows[0]?.tickets ?? 0, buyers: rows[0]?.buyers ?? 0 };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeAll(async () => {
  // The API's default pool of 20 connections, so the race runs as it would on a real server.
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: false });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
});

afterAll(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe.each([0, 50])(
  `${BUYERS} parallel naive buys of seat ${SEAT_ID}, RACE_DELAY_MS=%i`,
  (raceDelayMs) => {
    let result: RaceResult;

    // Run once in a hook: if the race can't run at all, the hook fails and so does CI, instead of
    // it.fails quietly counting a broken setup as the expected failure.
    beforeAll(async () => {
      result = await race(raceDelayMs);
      console.info(
        `seat ${SEAT_ID} sold ${result.tickets} times to ${BUYERS} parallel buyers at RACE_DELAY_MS=${raceDelayMs}`,
      );
    });

    it('gets a clean 201 or 409 for every request, and a ticket for every 201', () => {
      expect(result.statuses.filter((status) => status !== 201 && status !== 409)).toEqual([]);
      expect(result.tickets).toBe(result.statuses.filter((status) => status === 201).length);
      expect(result.buyers).toBe(result.tickets);
      expect(result.tickets).toBeGreaterThan(0);
    });

    // INV-1: a seat has at most one valid ticket. The naive buy breaks it, which is the point.
    if (raceDelayMs === PROOF_DELAY_MS) {
      it.fails('sells the seat to exactly one buyer', () => {
        expect(result.tickets).toBe(1);
      });
    }
  },
);
