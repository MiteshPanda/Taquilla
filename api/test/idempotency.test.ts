import { Router } from 'express';
import type { Request, Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedStadium } from '../../scripts/seed.js';
import { createApp } from '../src/app.js';
import { requireAuth } from '../src/auth/middleware.js';
import { signToken } from '../src/auth/tokens.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import { canonicalJson, hashRequest } from '../src/idempotency/hash.js';
import { idempotency, REPLAYED_HEADER } from '../src/idempotency/middleware.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { schemaConnectionString } from './helpers/database.js';

const SCHEMA = 'idempotency_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'idempotency-secret-at-least-32-chars';
const FAN = 1;
const RIVAL = 2;

const logger = createLogger('silent');

let db: Database;

function tokenFor(userId: number): string {
  return `Bearer ${signToken(userId, JWT_SECRET, 3600)}`;
}

interface KeyRow {
  status: string;
  response_code: number | null;
  response_body: unknown;
}

async function keyRow(key: string, userId = FAN): Promise<KeyRow | undefined> {
  const { rows } = await db.pool.query<KeyRow>(
    `SELECT status, response_code, response_body FROM idempotency_keys
      WHERE user_id = $1 AND idem_key = $2`,
    [userId, key],
  );
  return rows[0];
}

// A promise the test resolves by hand, to hold a request in the middle of its handler.
function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function errorCode(body: unknown): unknown {
  return (body as { error?: { code?: string } }).error?.code;
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
});

beforeEach(async () => {
  await db.pool.query('DELETE FROM idempotency_keys');
});

afterAll(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('the request hash', () => {
  it('reads objects with their keys in any order as the same body', () => {
    expect(canonicalJson({ b: 2, a: { d: [1, { f: 1, e: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"e":2,"f":1}]},"b":2}',
    );
    expect(hashRequest('POST', '/x', { a: 1, b: 2 })).toBe(
      hashRequest('post', '/x', { b: 2, a: 1 }),
    );
  });

  it.each([
    ['the method', hashRequest('PUT', '/x', { a: 1 })],
    ['the path', hashRequest('POST', '/y', { a: 1 })],
    ['a value', hashRequest('POST', '/x', { a: 2 })],
    ['an extra field', hashRequest('POST', '/x', { a: 1, b: 1 })],
    ['a string for a number', hashRequest('POST', '/x', { a: '1' })],
  ])('changes with %s', (_name, other) => {
    expect(other).not.toBe(hashRequest('POST', '/x', { a: 1 }));
  });

  it('keeps the order of arrays, so other seats in another order are another request', () => {
    expect(hashRequest('POST', '/x', { seatIds: [41, 42] })).not.toBe(
      hashRequest('POST', '/x', { seatIds: [42, 41] }),
    );
  });

  it('reads a missing body as null', () => {
    expect(hashRequest('POST', '/x', undefined)).toBe(hashRequest('POST', '/x', null));
  });
});

describe('the idempotency middleware', () => {
  // What the scripted route does next; each test sets it.
  let handle: (req: Request, res: Response) => Promise<void> | void;
  let runs: number;
  let app: ReturnType<typeof createApp>;

  function post(key: string | undefined, body: unknown = { amount: 1 }, path = '/things/1') {
    let req = request(app).post(path).set('Authorization', tokenFor(FAN));
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    return req.send(body as object);
  }

  beforeAll(() => {
    const routes = Router();
    const route = async (req: Request, res: Response) => {
      runs += 1;
      await handle(req, res);
    };
    routes.post('/things/:id', requireAuth(JWT_SECRET), idempotency({ db, required: true }), route);
    routes.post('/optional', requireAuth(JWT_SECRET), idempotency({ db, required: false }), route);
    app = createApp({ config: { CORS_ORIGINS: [] }, logger, routes });
  });

  beforeEach(() => {
    runs = 0;
    handle = (req, res) => {
      res.status(201).json({ run: runs, body: req.body as unknown });
    };
  });

  it('runs the request and saves its answer under the key', async () => {
    const res = await post('k-1').expect(201);

    expect(res.body).toEqual({ run: 1, body: { amount: 1 } });
    expect(res.headers[REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    expect(await keyRow('k-1')).toEqual({
      status: 'done',
      response_code: 201,
      response_body: { run: 1, body: { amount: 1 } },
    });
  });

  it('replays the saved answer for a repeated key, without running again (FR-IDEM-3)', async () => {
    const first = await post('k-1');

    const second = await post('k-1');

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers[REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(runs).toBe(1);
  });

  it('treats the same body with its keys in another order as a repeat', async () => {
    await post('k-1', { a: 1, b: { c: 2, d: 3 } });

    const res = await post('k-1', { b: { d: 3, c: 2 }, a: 1 });

    expect(res.headers[REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(runs).toBe(1);
  });

  it.each([
    ['a different body', { amount: 2 }, '/things/1'],
    ['another path', { amount: 1 }, '/things/2'],
  ])('answers 422 for the same key with %s (FR-IDEM-4)', async (_name, body, path) => {
    const first = await post('k-1');

    const res = await post('k-1', body, path).expect(422);

    expect(errorCode(res.body)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(runs).toBe(1);
    expect((await post('k-1')).body).toEqual(first.body);
  });

  it('answers 409 while the first request is still running, then replays it (FR-IDEM-5)', async () => {
    const { opened, open } = gate();
    handle = async (_req, res) => {
      await opened;
      res.status(201).json({ done: true });
    };
    const first = post('k-1').then((res) => res);

    // The first request is held inside its handler, so its key is in progress.
    await expect.poll(() => runs).toBe(1);
    const during = await post('k-1').expect(409);
    open();
    await first;
    const after = await post('k-1').expect(201);

    expect(errorCode(during.body)).toBe('REQUEST_IN_PROGRESS');
    expect(after.body).toEqual({ done: true });
    expect(after.headers[REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(runs).toBe(1);
  });

  it('runs two identical requests sent at the same instant once', async () => {
    handle = async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      res.status(201).json({ done: true });
    };

    const replies = await Promise.all(Array.from({ length: 10 }, () => post('k-1')));

    expect(runs).toBe(1);
    const fresh = replies.filter(
      (res) => res.status === 201 && res.headers[REPLAYED_HEADER.toLowerCase()] === undefined,
    );
    expect(fresh).toHaveLength(1);
    // The rest arrived while it ran, or (on a slow machine) just after it finished.
    for (const res of replies.filter((reply) => !fresh.includes(reply))) {
      if (res.status === 409) expect(errorCode(res.body)).toBe('REQUEST_IN_PROGRESS');
      else expect(res.body).toEqual({ done: true });
    }
  });

  it('releases the key when the request fails with a 5xx, so a retry runs it again (FR-IDEM-6)', async () => {
    handle = () => {
      throw new Error('the database fell over');
    };
    await post('k-1').expect(500);

    expect(await keyRow('k-1')).toBeUndefined();

    handle = (_req, res) => {
      res.status(201).json({ done: true });
    };
    await post('k-1').expect(201);
    expect(runs).toBe(2);
  });

  it('releases the key on 409 SEAT_BUSY, which asks the client to try again', async () => {
    handle = () => {
      throw new AppError(409, 'SEAT_BUSY', 'Those seats are busy right now.');
    };
    await post('k-1').expect(409);

    expect(await keyRow('k-1')).toBeUndefined();
    await post('k-1').expect(409);
    expect(runs).toBe(2);
  });

  it('saves any other 4xx as the outcome and replays it', async () => {
    handle = () => {
      throw new AppError(409, 'SEAT_TAKEN', 'Seat 42 was just taken.', { seatIds: [42] });
    };
    const first = await post('k-1').expect(409);

    const second = await post('k-1').expect(409);

    expect(second.body).toEqual(first.body);
    expect(second.headers[REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(runs).toBe(1);
  });

  it('answers 400 without a key where one is required (FR-PAY-1)', async () => {
    const res = await post(undefined).expect(400);

    expect(errorCode(res.body)).toBe('VALIDATION_FAILED');
    expect(runs).toBe(0);
  });

  it.each([
    ['too long', 'k'.repeat(129)],
    ['a space', 'two words'],
    ['a character outside ASCII', 'clé'],
  ])('answers 400 for a key with %s', async (_name, key) => {
    const res = await post(key).expect(400);

    expect(errorCode(res.body)).toBe('VALIDATION_FAILED');
    expect(runs).toBe(0);
  });

  it('accepts a key of 128 visible characters', async () => {
    await post('~'.repeat(128)).expect(201);
  });

  it('runs every request without a key where one is optional, saving nothing (FR-IDEM-1)', async () => {
    await post(undefined, { amount: 1 }, '/optional').expect(201);
    await post(undefined, { amount: 1 }, '/optional').expect(201);

    expect(runs).toBe(2);
    const { rows } = await db.pool.query('SELECT 1 FROM idempotency_keys');
    expect(rows).toEqual([]);
  });

  it('keeps one fan’s keys apart from another’s (FR-IDEM-2)', async () => {
    await post('shared', { amount: 1 }).expect(201);

    const rival = await request(app)
      .post('/things/1')
      .set('Authorization', tokenFor(RIVAL))
      .set('Idempotency-Key', 'shared')
      .send({ amount: 2 })
      .expect(201);

    expect(rival.headers[REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    expect(runs).toBe(2);
  });

  describe('a key left in progress (FR-IDEM-7)', () => {
    async function stuckKey(key: string, secondsAgo: number): Promise<void> {
      await db.pool.query(
        `INSERT INTO idempotency_keys (user_id, idem_key, request_hash, locked_at)
         VALUES ($1, $2, $3, now() - make_interval(secs => $4))`,
        [FAN, key, hashRequest('POST', '/things/1', { amount: 1 }), secondsAgo],
      );
    }

    it('still counts as running at 59 seconds', async () => {
      await stuckKey('k-1', 59);

      const res = await post('k-1').expect(409);

      expect(errorCode(res.body)).toBe('REQUEST_IN_PROGRESS');
      expect(runs).toBe(0);
    });

    it('is taken over by a new request after 60 seconds', async () => {
      await stuckKey('k-1', 61);

      await post('k-1').expect(201);

      expect(runs).toBe(1);
      expect(await keyRow('k-1')).toMatchObject({ status: 'done', response_code: 201 });
    });

    it('still answers 422 to a different body after 60 seconds', async () => {
      await stuckKey('k-1', 61);

      await post('k-1', { amount: 2 }).expect(422);

      expect(runs).toBe(0);
    });

    it.each([
      ['succeeds', 201],
      ['fails', 500],
    ])(
      'leaves the key to the newer request when the stale one %s while the newer one runs',
      async (_name, lateStatus) => {
        const staleGate = gate();
        const newerGate = gate();
        handle = async (_req, res) => {
          const run = runs;
          if (run === 1) {
            await staleGate.opened;
            if (lateStatus === 500) throw new Error('late failure');
          } else if (run === 2) {
            await newerGate.opened;
          }
          res.status(201).json({ run: run === 1 ? 'stale' : 'newer' });
        };
        const stale = post('k-1').then((res) => res);
        await expect.poll(() => runs).toBe(1);

        // The first request hangs past a minute, so a retry takes its key over.
        await db.pool.query(
          `UPDATE idempotency_keys SET locked_at = now() - interval '61 seconds'`,
        );
        const newer = post('k-1').then((res) => res);
        await expect.poll(() => runs).toBe(2);

        // The stale request finishes first. The key is still in progress, but it is no longer
        // that request's, so its answer must neither be saved nor release the key.
        staleGate.open();
        const late = await stale;
        const meanwhile = await post('k-1');
        newerGate.open();
        const newerReply = await newer;

        expect(late.status).toBe(lateStatus);
        expect(meanwhile.status).toBe(409);
        expect(errorCode(meanwhile.body)).toBe('REQUEST_IN_PROGRESS');
        expect(newerReply.body).toEqual({ run: 'newer' });
        expect((await post('k-1')).body).toEqual({ run: 'newer' });
        expect(runs).toBe(2);
      },
    );
  });
});

describe('POST /events/:id/holds with an Idempotency-Key', () => {
  let app: ReturnType<typeof createApp>;

  function hold(seatIds: number[], key?: string) {
    let req = request(app).post('/events/1/holds').set('Authorization', tokenFor(FAN));
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    return req.send({ seatIds });
  }

  async function holdCount(): Promise<number> {
    const { rows } = await db.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM holds',
    );
    return rows[0]?.count ?? -1;
  }

  beforeAll(() => {
    const config = {
      NODE_ENV: 'test' as const,
      JWT_SECRET,
      JWT_EXPIRES_IN: 3600,
      RACE_DELAY_MS: 0,
    };
    const holdStrategy = createHoldStrategy('lock', { db, holdSeconds: 300, logger });
    app = createApp({
      config: { CORS_ORIGINS: [] },
      logger,
      routes: createRoutes({ db, config, holdStrategy }),
    });
  });

  beforeEach(async () => {
    await db.pool.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
        WHERE status <> 'available'`,
    );
    await db.pool.query('DELETE FROM holds');
  });

  it('returns the same hold for a retried request, and holds the seats once', async () => {
    const first = await hold([41, 42], 'hold-1').expect(201);

    const retry = await hold([41, 42], 'hold-1').expect(201);

    expect(retry.body).toEqual(first.body);
    expect(retry.headers[REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(await holdCount()).toBe(1);
  });

  it('answers 422 for the same key with other seats', async () => {
    await hold([41, 42], 'hold-1').expect(201);

    const res = await hold([43], 'hold-1').expect(422);

    expect(errorCode(res.body)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await holdCount()).toBe(1);
  });

  it('gives 10 identical holds sent at once one hold between them', async () => {
    const replies = await Promise.all(Array.from({ length: 10 }, () => hold([42], 'hold-1')));

    expect(await holdCount()).toBe(1);
    expect(replies.filter((res) => res.status >= 500)).toEqual([]);
    const holdIds = new Set(
      replies
        .filter((res) => res.status === 201)
        .map((res) => (res.body as { holdId: string }).holdId),
    );
    expect(holdIds.size).toBe(1);
  });

  it('still makes a new hold for every request without a key', async () => {
    await hold([41]).expect(201);
    await hold([42]).expect(201);

    expect(await holdCount()).toBe(2);
  });
});
