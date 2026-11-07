import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedStadium } from '../src/seed.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createSweeper, heartbeatIsFresh, KEY_TTL_HOURS } from '../src/jobs/sweeper.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { schemaConnectionString } from './helpers/database.js';

const SCHEMA = 'sweeper_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const SWEEPER_CLI = path.resolve(import.meta.dirname, '../src/jobs/sweeper-cli.ts');
const HEALTH_CLI = path.resolve(import.meta.dirname, '../src/jobs/sweeper-health-cli.ts');

interface LogLine {
  level: number;
  msg: string;
  freed?: number;
  keysDeleted?: number;
}

const logs: LogLine[] = [];
const logger = createLogger('debug', {
  write: (line: string) => logs.push(JSON.parse(line) as LogLine),
});
const LEVEL = { debug: 20, info: 30, error: 50 };

let db: Database;

// Puts seats on hold for fan 1, lapsing after heldFor (negative means already lapsed).
async function holdSeats(seatIds: number[], heldFor: string): Promise<void> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO holds (user_id, event_id, seat_ids, amount_paise) VALUES (1, 1, $1, 1) RETURNING id`,
    [seatIds.slice(0, 6)],
  );
  await db.pool.query(
    `UPDATE seats SET status = 'held', hold_id = $1, held_until = now() + $2::interval
      WHERE id = ANY($3::int[])`,
    [rows[0]?.id, heldFor, seatIds],
  );
}

// An idempotency key claimed hoursAgo, finished unless stuck says it never was.
async function keyFrom(key: string, hoursAgo: number, { stuck = false } = {}): Promise<void> {
  await db.pool.query(
    `INSERT INTO idempotency_keys
       (user_id, idem_key, request_hash, status, response_code, response_body, locked_at)
     VALUES (1, $1, 'hash', $2, $3, $4, now() - make_interval(hours => $5))`,
    [key, stuck ? 'in_progress' : 'done', stuck ? null : 200, stuck ? null : '{}', hoursAgo],
  );
}

async function keysLeft(): Promise<string[]> {
  const { rows } = await db.pool.query<{ idem_key: string }>(
    'SELECT idem_key FROM idempotency_keys ORDER BY idem_key',
  );
  return rows.map((row) => row.idem_key);
}

async function statusOf(seatIds: number[]): Promise<string[]> {
  const { rows } = await db.pool.query<{ status: string }>(
    'SELECT status FROM seats WHERE id = ANY($1::int[]) ORDER BY id',
    [seatIds],
  );
  return rows.map((row) => row.status);
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.');
    await sleep(20);
  }
}

// A stand-in for the database, for testing only the scheduling: each transaction takes runMs.
function slowDatabase(runMs: number, fail: () => boolean = () => false) {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  return {
    stats: () => ({ maxActive, runs }),
    db: {
      async withTransaction<T>(): Promise<T> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        runs += 1;
        await sleep(runMs);
        active -= 1;
        if (fail()) throw new Error('database unavailable');
        return 0 as T;
      },
    } as unknown as Pick<Database, 'withTransaction'>,
  };
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger: createLogger('silent') });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({
    connectionString: CONNECTION_STRING,
    logger: createLogger('silent'),
    production: true,
  });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
});

beforeEach(async () => {
  logs.length = 0;
  await db.pool.query(
    `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
      WHERE status <> 'available'`,
  );
  await db.pool.query('DELETE FROM holds');
  await db.pool.query('DELETE FROM idempotency_keys');
});

afterAll(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('sweepOnce', () => {
  it('frees lapsed seats and nothing else', async () => {
    await holdSeats([41, 42], '-1 second');
    await holdSeats([43], '5 minutes');
    await db.pool.query(`UPDATE seats SET status = 'sold' WHERE id = 44`);

    const freed = await createSweeper({ db, logger, intervalMs: 1_000 }).sweepOnce();

    expect(freed).toBe(2);
    expect(await statusOf([41, 42, 43, 44, 45])).toEqual([
      'available',
      'available',
      'held',
      'sold',
      'available',
    ]);
    const { rows } = await db.pool.query(
      'SELECT 1 FROM seats WHERE id IN (41, 42) AND (hold_id IS NOT NULL OR held_until IS NOT NULL)',
    );
    expect(rows).toEqual([]);
  });

  it('returns 0 when nothing has lapsed', async () => {
    await holdSeats([43], '5 minutes');

    expect(await createSweeper({ db, logger, intervalMs: 1_000 }).sweepOnce()).toBe(0);
  });

  it('drains a backlog in batches, one transaction each, within a single run', async () => {
    const seatIds = [41, 42, 43, 44, 45, 46, 47];
    await holdSeats(seatIds, '-1 second');
    let transactions = 0;
    const counting: Pick<Database, 'withTransaction'> = {
      withTransaction: (fn, options) => {
        transactions += 1;
        return db.withTransaction(fn, options);
      },
    };

    const freed = await createSweeper({
      db: counting,
      logger,
      intervalMs: 1_000,
      batchSize: 3,
    }).sweepOnce();

    expect(freed).toBe(7);
    // 3, 3 and 1: the short batch tells it the backlog is gone.
    expect(transactions).toBe(3);
    expect(new Set(await statusOf(seatIds))).toEqual(new Set(['available']));
  });

  it('steps past a seat a booking has locked instead of waiting, and frees it on a later run', async () => {
    await holdSeats([41, 42], '-1 second');
    const booking = new Client({ connectionString: CONNECTION_STRING });
    await booking.connect();
    const sweeper = createSweeper({ db, logger, intervalMs: 1_000 });
    try {
      await booking.query('BEGIN');
      await booking.query('SELECT 1 FROM seats WHERE id = 41 FOR UPDATE');

      const startedAt = performance.now();
      const freed = await sweeper.sweepOnce();

      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(freed).toBe(1);
      expect(await statusOf([41, 42])).toEqual(['held', 'available']);
    } finally {
      await booking.query('ROLLBACK');
      await booking.end();
    }

    expect(await sweeper.sweepOnce()).toBe(1);
    expect(await statusOf([41])).toEqual(['available']);
  });
});

describe('deleteOldKeys (FR-EXP-5)', () => {
  it(`deletes keys older than ${KEY_TTL_HOURS} hours, finished or stuck, and keeps younger ones`, async () => {
    await keyFrom('old-done', 25);
    await keyFrom('old-stuck', 25, { stuck: true });
    await keyFrom('young', 23);

    const deleted = await createSweeper({ db, logger, intervalMs: 1_000 }).deleteOldKeys();

    expect(deleted).toBe(2);
    expect(await keysLeft()).toEqual(['young']);
  });

  it('drains a backlog in batches within a single run', async () => {
    for (let i = 0; i < 7; i += 1) await keyFrom(`old-${i}`, 30);

    const deleted = await createSweeper({
      db,
      logger,
      intervalMs: 1_000,
      batchSize: 3,
    }).deleteOldKeys();

    expect(deleted).toBe(7);
    expect(await keysLeft()).toEqual([]);
  });

  it('steps past a key a request has locked, and deletes it on a later run', async () => {
    await keyFrom('old-locked', 25);
    const sweeper = createSweeper({ db, logger, intervalMs: 1_000 });
    const other = new Client({ connectionString: CONNECTION_STRING });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(`SELECT 1 FROM idempotency_keys WHERE idem_key = 'old-locked' FOR UPDATE`);

      const startedAt = performance.now();
      expect(await sweeper.deleteOldKeys()).toBe(0);
      expect(performance.now() - startedAt).toBeLessThan(1_000);

      await other.query('ROLLBACK');
      expect(await sweeper.deleteOldKeys()).toBe(1);
    } finally {
      await other.end();
    }
  });

  it('runs as part of every sweep, and logs the count', async () => {
    await keyFrom('old', 25);
    const sweeper = createSweeper({ db, logger, intervalMs: 1_000 });

    sweeper.start();
    await waitFor(() => Promise.resolve(logs.some((line) => line.msg === 'sweep finished')));
    await sweeper.stop();

    expect(logs.find((line) => line.msg === 'sweep finished')).toMatchObject({
      level: LEVEL.info,
      freed: 0,
      keysDeleted: 1,
    });
    expect(await keysLeft()).toEqual([]);
  });
});

describe('start and stop', () => {
  it('runs straight away and then every interval', async () => {
    const sweeper = createSweeper({ db, logger, intervalMs: 50 });
    await holdSeats([41], '-1 second');
    sweeper.start();
    try {
      await waitFor(async () => (await statusOf([41]))[0] === 'available');
      await holdSeats([42], '-1 second');
      await waitFor(async () => (await statusOf([42]))[0] === 'available');
    } finally {
      await sweeper.stop();
    }
  });

  it('runs no more once stopped', async () => {
    const sweeper = createSweeper({ db, logger, intervalMs: 20 });
    sweeper.start();
    await sleep(60);
    await sweeper.stop();

    await holdSeats([41], '-1 second');
    await sleep(150);

    expect(await statusOf([41])).toEqual(['held']);
  });

  it('never starts a run while the last one is still going', async () => {
    const fake = slowDatabase(30);
    const sweeper = createSweeper({ db: fake.db, logger, intervalMs: 1 });

    sweeper.start();
    await sleep(250);
    await sweeper.stop();

    expect(fake.stats().maxActive).toBe(1);
    expect(fake.stats().runs).toBeGreaterThan(3);
  });

  it('lets a run in progress finish before stop resolves', async () => {
    const fake = slowDatabase(150);
    const sweeper = createSweeper({ db: fake.db, logger, intervalMs: 1_000 });
    sweeper.start();
    await sleep(20);

    const startedAt = performance.now();
    await sweeper.stop();

    expect(performance.now() - startedAt).toBeGreaterThan(100);
    expect(fake.stats().runs).toBe(1);
  });

  it('keeps going after a run fails, logging the error', async () => {
    let calls = 0;
    const fake = slowDatabase(1, () => (calls += 1) <= 2);
    const sweeper = createSweeper({ db: fake.db, logger, intervalMs: 5 });

    sweeper.start();
    await waitFor(() => Promise.resolve(fake.stats().runs >= 4));
    await sweeper.stop();

    const errors = logs.filter((line) => line.level === LEVEL.error);
    expect(errors.map((line) => line.msg)).toEqual([
      'sweep failed; trying again at the next interval',
      'sweep failed; trying again at the next interval',
    ]);
  });

  it('logs how many seats each run freed: at info when it freed some, at debug when none', async () => {
    const sweeper = createSweeper({ db, logger, intervalMs: 1_000 });
    await holdSeats([41, 42, 43], '-1 second');

    sweeper.start();
    await waitFor(() => Promise.resolve(logs.some((line) => line.msg === 'sweep finished')));
    await sweeper.stop();
    logs.length = 0;
    sweeper.start();
    await waitFor(() => Promise.resolve(logs.some((line) => line.msg === 'sweep finished')));
    await sweeper.stop();

    expect(logs.find((line) => line.msg === 'sweep finished')).toMatchObject({
      level: LEVEL.debug,
      freed: 0,
    });
  });
});

// Windows can't send SIGTERM to another process (it kills it outright), so CI runs this on Linux.
describe('the heartbeat for the container health check (WP 8.1)', () => {
  it.each([
    ['10 s', 10_000, 30_000],
    ['60 s', 60_000, 180_000],
    ['1 s, so the 30 s minimum applies', 1_000, 30_000],
  ])(
    'with an interval of %s, counts a run up to %i ms ago as fresh',
    (_name, intervalMs, limitMs) => {
      const now = 1_000_000_000;

      expect(heartbeatIsFresh(now - limitMs, now, intervalMs)).toBe(true);
      expect(heartbeatIsFresh(now - limitMs - 1, now, intervalMs)).toBe(false);
    },
  );

  it('is recorded after each run that succeeded, and never after one that failed', async () => {
    let calls = 0;
    const fake = slowDatabase(1, () => (calls += 1) <= 2);
    let beats = 0;
    const sweeper = createSweeper({
      db: fake.db,
      logger,
      intervalMs: 5,
      onRunSucceeded: () => {
        beats += 1;
        return Promise.resolve();
      },
    });

    sweeper.start();
    await waitFor(() => Promise.resolve(fake.stats().runs >= 8));
    await sweeper.stop();

    const finished = logs.filter((line) => line.msg === 'sweep finished').length;
    const failed = logs.filter((line) => line.msg.startsWith('sweep failed')).length;
    expect(failed).toBe(2);
    expect(finished).toBeGreaterThanOrEqual(3);
    expect(beats).toBe(finished);
  });

  it('logs a heartbeat it could not record, and keeps sweeping', async () => {
    const fake = slowDatabase(1);
    const sweeper = createSweeper({
      db: fake.db,
      logger,
      intervalMs: 5,
      onRunSucceeded: () => Promise.reject(new Error('disk full')),
    });

    sweeper.start();
    await waitFor(() => Promise.resolve(fake.stats().runs >= 6));
    await sweeper.stop();

    const errors = logs.filter((line) => line.level === LEVEL.error).map((line) => line.msg);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(new Set(errors)).toEqual(new Set(['could not record the sweep for the health check']));
  });

  describe('the health check command', { timeout: 30_000 }, () => {
    let dir: string;
    let file: string;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'taquilla-heartbeat-'));
      file = path.join(dir, 'heartbeat');
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function check(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
      const child = spawn(process.execPath, ['--import', 'tsx', HEALTH_CLI], {
        env: { ...process.env, SWEEP_INTERVAL_SECONDS: '10', ...env },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const [code] = (await once(child, 'exit')) as [number];
      return { code, stderr };
    }

    it('passes while the last run is recent', async () => {
      await writeFile(file, new Date().toISOString());

      expect(await check({ SWEEPER_HEARTBEAT_FILE: file })).toEqual({ code: 0, stderr: '' });
    });

    it('fails once the last run is three intervals old', async () => {
      await writeFile(file, 'old');
      const old = new Date(Date.now() - 31_000);
      await utimes(file, old, old);

      const { code, stderr } = await check({ SWEEPER_HEARTBEAT_FILE: file });

      expect(code).toBe(1);
      expect(stderr).toContain("The sweeper's last successful run ended at");
    });

    it('fails before the first run has finished', async () => {
      const { code, stderr } = await check({ SWEEPER_HEARTBEAT_FILE: path.join(dir, 'none') });

      expect(code).toBe(1);
      expect(stderr).toContain('The sweeper has not finished a run yet.');
    });

    it('fails when the sweeper keeps no heartbeat', async () => {
      const { code, stderr } = await check({ SWEEPER_HEARTBEAT_FILE: '' });

      expect(code).toBe(1);
      expect(stderr).toContain('SWEEPER_HEARTBEAT_FILE is not set');
    });
  });
});

describe.skipIf(process.platform === 'win32')('the sweeper process', { timeout: 30_000 }, () => {
  it('frees lapsed seats, keeps a heartbeat, then stops cleanly with exit code 0 on SIGTERM', async () => {
    await holdSeats([41, 42], '-1 second');
    const dir = await mkdtemp(path.join(tmpdir(), 'taquilla-sweeper-'));
    const heartbeat = path.join(dir, 'heartbeat');
    const child = spawn(process.execPath, ['--import', 'tsx', SWEEPER_CLI], {
      env: {
        ...process.env,
        DATABASE_URL: CONNECTION_STRING,
        SWEEP_INTERVAL_SECONDS: '1',
        SWEEPER_HEARTBEAT_FILE: heartbeat,
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('"freed":2')) child.kill('SIGTERM');
    });

    const [exitCode] = (await once(child, 'exit')) as [number | null];

    expect(exitCode).toBe(0);
    expect(stdout).toContain('"msg":"sweeper started"');
    expect(stdout).toContain('"signal":"SIGTERM","msg":"sweeper stopping"');
    expect(stdout).toContain('"msg":"sweeper stopped"');
    expect(await statusOf([41, 42])).toEqual(['available', 'available']);
    expect((await stat(heartbeat)).isFile()).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});
