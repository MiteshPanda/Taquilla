// The hosted demo's single process (WP 8.4): the API with the payment mock and the sweeper inside
// it. A real server process books and pays for seats, and lets a lapsed hold go, on its own.
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEmbeddedPayments } from '../../payments-mock/src/embedded.js';
import { signToken } from '../src/auth/tokens.js';
import { loadEmbeddedPayments } from '../src/checkout/embedded-payments.js';
import type { StartEmbeddedPayments } from '../src/checkout/embedded-payments.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { seedStadium } from '../src/seed.js';
import { TEST_DATABASE_URL } from './helpers/database.js';

// A database of its own, since the mock creates its payments schema wherever it runs.
const PROBE_DATABASE = 'taquilla_in_process_probe';
const PROBE_URL = TEST_DATABASE_URL.replace(/taquilla_test$/, PROBE_DATABASE);
const SERVER = path.resolve(import.meta.dirname, '../src/server.ts');
const JWT_SECRET = 'in-process-secret-at-least-32-characters';
const logger = createLogger('silent');

// The API's own idea of the mock's start function must still fit the mock's real one.
const typeCheck: StartEmbeddedPayments = startEmbeddedPayments;

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function freePort(): Promise<number> {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  probe.close();
  return port;
}

describe('loadEmbeddedPayments', () => {
  it('loads the mock from its source under tsx, the same function the mock exports', async () => {
    expect(typeCheck).toBe(startEmbeddedPayments);
    const start = await loadEmbeddedPayments();

    expect(start.name).toBe('startEmbeddedPayments');
  });

  // npm run build has run first, as in CI and the image.
  it('loads the compiled mock beside the compiled API, as the image runs it', async () => {
    const compiled = new URL('../dist/checkout/embedded-payments.js', import.meta.url).href;
    const start = await loadEmbeddedPayments(compiled);

    expect(start.name).toBe('startEmbeddedPayments');
  });

  it('fails when the mock is not where the API expects it', async () => {
    const elsewhere = new URL('../../../outside/the/repo/file.ts', import.meta.url).href;

    await expect(loadEmbeddedPayments(elsewhere)).rejects.toThrow();
  });
});

describe('the API with the mock and the sweeper in its process', { timeout: 60_000 }, () => {
  let db: Database;
  let child: ChildProcessWithoutNullStreams;
  let base = '';
  let stdout = '';
  const auth = `Bearer ${signToken(1, JWT_SECRET, 3600)}`;

  const post = (url: string, body: unknown, key: string) =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${PROBE_DATABASE} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${PROBE_DATABASE}`);
    await runMigrations({ connectionString: PROBE_URL, logger, production: true });
    db = createDatabase({ connectionString: PROBE_URL, logger });
    await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['--import', 'tsx', SERVER], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        DATABASE_URL: PROBE_URL,
        PORT: String(port),
        JWT_SECRET,
        PAYMENTS_IN_PROCESS: 'true',
        SWEEPER_IN_PROCESS: 'true',
        SWEEP_INTERVAL_SECONDS: '1',
        // Nowhere: the payments must go to the mock in the process, not here.
        PAYMENTS_URL: 'http://127.0.0.1:1',
        DECLINE_RATE: '0',
        LOST_RESPONSE_RATE: '0',
        LATENCY_MIN_MS: '0',
        LATENCY_MAX_MS: '0',
      },
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    for (let i = 0; i < 300 && !stdout.includes('"msg":"server listening"'); i += 1) {
      if (child.exitCode !== null) throw new Error(`The server exited:\n${stdout}`);
      await sleep(50);
    }
    expect(stdout).toContain('"msg":"server listening"');
  });

  afterAll(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await db.close();
    await admin(`DROP DATABASE IF EXISTS ${PROBE_DATABASE} WITH (FORCE)`);
  });

  it('starts the mock and the sweeper with the API', () => {
    expect(stdout).toContain('"msg":"payments mock running in this process"');
    expect(stdout).toContain('"msg":"sweeper running in this process"');
  });

  it('holds seats and pays for them through the mock in the process', async () => {
    const held = await post('/events/1/holds', { seatIds: [41, 42] }, 'in-process-hold');
    expect(held.status).toBe(201);
    const { holdId } = (await held.json()) as { holdId: string };

    const paid = await post(`/holds/${holdId}/checkout`, {}, 'in-process-pay');

    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ status: 'paid', amountPaise: 900_000 });
    const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM payments.charges');
    expect(rows).toEqual([{ status: 'succeeded' }]);
  });

  it('frees a lapsed hold without a sweeper of its own', async () => {
    expect((await post('/events/1/holds', { seatIds: [50] }, 'in-process-lapse')).status).toBe(201);
    await db.pool.query(`UPDATE seats SET held_until = now() - interval '1 second' WHERE id = 50`);

    let status = 'held';
    for (let i = 0; i < 100 && status !== 'available'; i += 1) {
      await sleep(50);
      const { rows } = await db.pool.query<{ status: string }>(
        'SELECT status FROM seats WHERE id = 50',
      );
      status = rows[0]?.status ?? '';
    }

    expect(status).toBe('available');
  });

  // Windows has no SIGTERM to send, so the clean stop is checked where CI runs.
  it.skipIf(process.platform === 'win32')(
    'stops the sweeper and the mock, then the pool, with exit code 0 on SIGTERM',
    async () => {
      child.kill('SIGTERM');
      const [code] = (await once(child, 'exit')) as [number | null];

      expect(code).toBe(0);
      expect(stdout).toContain('"msg":"shutdown complete"');
    },
  );
});
