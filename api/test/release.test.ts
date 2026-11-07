import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedStadium } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth/tokens.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { schemaConnectionString } from './helpers/database.js';
import { NO_PAYMENTS } from './helpers/payments.js';

const SCHEMA = 'release_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'release-test-secret-at-least-32-chars';
const FAN = 1;
const RIVAL = 2;

const logger = createLogger('silent');
const NO_SUCH_HOLD = { error: { code: 'NOT_FOUND', message: 'This hold does not exist.' } };

let db: Database;
let app: ReturnType<typeof createApp>;

function auth(userId: number): string {
  return `Bearer ${signToken(userId, JWT_SECRET, 3600)}`;
}

async function hold(seatIds: number[], userId = FAN): Promise<string> {
  const res = await request(app)
    .post('/events/1/holds')
    .set('Authorization', auth(userId))
    .send({ seatIds })
    .expect(201);
  return (res.body as { holdId: string }).holdId;
}

function release(holdId: string, userId = FAN) {
  return request(app).delete(`/holds/${holdId}`).set('Authorization', auth(userId));
}

async function seats(ids: number[]) {
  const { rows } = await db.pool.query<{ id: number; status: string; hold_id: string | null }>(
    'SELECT id, status, hold_id FROM seats WHERE id = ANY($1::int[]) ORDER BY id',
    [ids],
  );
  return rows;
}

async function holdStatus(holdId: string): Promise<string | undefined> {
  const { rows } = await db.pool.query<{ status: string }>(
    'SELECT status FROM holds WHERE id = $1',
    [holdId],
  );
  return rows[0]?.status;
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
  const config = { NODE_ENV: 'test' as const, JWT_SECRET, JWT_EXPIRES_IN: 3600, RACE_DELAY_MS: 0 };
  const holdStrategy = createHoldStrategy('lock', { db, holdSeconds: 300, logger });
  app = createApp({
    config: { CORS_ORIGINS: [] },
    logger,
    routes: createRoutes({ db, config, holdStrategy, payments: NO_PAYMENTS }),
  });
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

describe('DELETE /holds/:id', () => {
  describe('the owner', () => {
    it('frees the seats, marks the hold released and answers 204 with no body', async () => {
      const holdId = await hold([41, 42]);

      const res = await release(holdId).expect(204);

      expect(res.text).toBe('');
      expect(await seats([41, 42])).toEqual([
        { id: 41, status: 'available', hold_id: null },
        { id: 42, status: 'available', hold_id: null },
      ]);
      expect(await holdStatus(holdId)).toBe('released');
    });

    it('lets another fan hold the seats straight away', async () => {
      const holdId = await hold([42]);
      await release(holdId).expect(204);

      await hold([42], RIVAL);
    });

    it('frees only the seats the hold still has, leaving one another fan took after it lapsed', async () => {
      const holdId = await hold([41, 42]);
      await db.pool.query(
        `UPDATE seats SET held_until = now() - interval '1 second' WHERE hold_id = $1`,
        [holdId],
      );
      const rivalHoldId = await hold([42], RIVAL);

      await release(holdId).expect(204);

      expect(await seats([41, 42])).toEqual([
        { id: 41, status: 'available', hold_id: null },
        { id: 42, status: 'held', hold_id: rivalHoldId },
      ]);
      expect(await holdStatus(rivalHoldId)).toBe('active');
    });

    it('frees a hold that has lapsed but not yet been swept', async () => {
      const holdId = await hold([42]);
      await db.pool.query(
        `UPDATE seats SET held_until = now() - interval '1 second' WHERE hold_id = $1`,
        [holdId],
      );

      await release(holdId).expect(204);

      expect(await seats([42])).toEqual([{ id: 42, status: 'available', hold_id: null }]);
    });

    it('leaves a paid hold converted and its seats sold', async () => {
      const holdId = await hold([42]);
      await db.pool.query(
        `UPDATE seats SET status = 'sold', hold_id = NULL, held_until = NULL WHERE id = 42`,
      );
      await db.pool.query(`UPDATE holds SET status = 'converted' WHERE id = $1`, [holdId]);

      await release(holdId).expect(204);

      expect(await seats([42])).toEqual([{ id: 42, status: 'sold', hold_id: null }]);
      expect(await holdStatus(holdId)).toBe('converted');
    });
  });

  describe('a repeated release', () => {
    it('is harmless: 204 again, nothing else changes', async () => {
      const holdId = await hold([41, 42]);
      await release(holdId).expect(204);
      const rivalHoldId = await hold([42], RIVAL);

      await release(holdId).expect(204);

      expect(await holdStatus(holdId)).toBe('released');
      expect(await seats([42])).toEqual([{ id: 42, status: 'held', hold_id: rivalHoldId }]);
    });

    it('is harmless when two arrive at the same moment', async () => {
      const holdId = await hold([41, 42]);

      const results = await Promise.all([release(holdId), release(holdId)]);

      expect(results.map((res) => res.status)).toEqual([204, 204]);
      expect(await holdStatus(holdId)).toBe('released');
      expect((await seats([41, 42])).map((seat) => seat.status)).toEqual([
        'available',
        'available',
      ]);
    });
  });

  describe('a stranger', () => {
    it("gets 404 for someone else's hold, and the hold is untouched", async () => {
      const holdId = await hold([41, 42]);

      await release(holdId, RIVAL).expect(404, NO_SUCH_HOLD);

      expect(await holdStatus(holdId)).toBe('active');
      expect((await seats([41, 42])).map((seat) => seat.hold_id)).toEqual([holdId, holdId]);
    });

    it('gets the same 404 for a hold that does not exist', async () => {
      await release('00000000-0000-4000-8000-000000000000', RIVAL).expect(404, NO_SUCH_HOLD);
    });

    it.each(['abc', '42', 'not-a-uuid-at-all'])('gets 404 for the malformed id %s', async (id) => {
      await release(id).expect(404, NO_SUCH_HOLD);
    });

    it('needs a login', async () => {
      const holdId = await hold([42]);

      await request(app).delete(`/holds/${holdId}`).expect(401);
      expect(await holdStatus(holdId)).toBe('active');
    });
  });

  describe('racing new holds', () => {
    it('hands the seat to at most one of the fans asking while it is released', async () => {
      const holdId = await hold([42]);

      const results = await Promise.all([
        release(holdId),
        ...Array.from({ length: 10 }, (_, i) =>
          request(app)
            .post('/events/1/holds')
            .set('Authorization', auth(10 + i))
            .send({ seatIds: [42] }),
        ),
      ]);

      expect(results[0]?.status).toBe(204);
      const answers = results.slice(1).map((res) => res.status);
      expect(answers.filter((status) => status !== 201 && status !== 409)).toEqual([]);
      const winners = results.slice(1).filter((res) => res.status === 201);
      expect(winners.length).toBeLessThanOrEqual(1);
      const [seat] = await seats([42]);
      expect(seat?.hold_id).toBe(
        winners.length === 1 ? (winners[0]?.body as { holdId: string }).holdId : null,
      );
    });
  });
});
