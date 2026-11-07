import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedStadium } from '../src/seed.js';
import { TOKENS_FILE, writeTokens } from '../../scripts/tokens.js';
import type { FanToken } from '../../scripts/tokens.js';
import { createApp } from '../src/app.js';
import { verifyToken } from '../src/auth/tokens.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { schemaConnectionString } from './helpers/database.js';
import { NO_PAYMENTS } from './helpers/payments.js';

const SCHEMA = 'tokens_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'tokens-test-secret-at-least-32-chars';
const LIFETIME_SECONDS = 3600;

const logger = createLogger('silent');
let db: Database;
let directory: string;
let outFile: string;

function write(overrides: { connectionString?: string; nodeEnv?: string } = {}) {
  return writeTokens({
    connectionString: CONNECTION_STRING,
    nodeEnv: 'test',
    jwtSecret: JWT_SECRET,
    expiresInSeconds: LIFETIME_SECONDS,
    logger,
    outFile,
    ...overrides,
  });
}

async function readTokens(): Promise<FanToken[]> {
  return JSON.parse(await readFile(outFile, 'utf8')) as FanToken[];
}

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
  // Someone who signed up: a real account, so it must never get a token.
  await db.pool.query(
    `INSERT INTO users (email, password_hash) VALUES ('someone@example.com', 'hash')`,
  );
});

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'taquilla-tokens-'));
  outFile = path.join(directory, 'loadtest', 'tokens.json');
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('writeTokens', () => {
  it('writes one token for each of the 1,000 seeded fans, in id order', async () => {
    const result = await write();

    const tokens = await readTokens();
    const { rows } = await db.pool.query<{ id: number }>(
      `SELECT id FROM users WHERE email LIKE 'fan%@taquilla.test' ORDER BY id`,
    );
    expect(result).toEqual({ count: 1_000, outFile });
    expect(tokens.map((entry) => entry.userId)).toEqual(rows.map((row) => row.id));
    expect(new Set(tokens.map((entry) => entry.token)).size).toBe(1_000);
  });

  it('signs tokens the API accepts, each for its own fan, lasting JWT_EXPIRES_IN', async () => {
    await write();

    for (const { userId, token } of await readTokens()) {
      expect(verifyToken(token, JWT_SECRET)).toBe(userId);
      const { exp, iat } = jwt.decode(token) as { exp: number; iat: number };
      expect(exp - iat).toBe(LIFETIME_SECONDS);
    }
  });

  it('leaves out accounts that are not seeded fans', async () => {
    await write();

    const { rows } = await db.pool.query<{ id: number }>(
      `SELECT id FROM users WHERE email = 'someone@example.com'`,
    );
    expect((await readTokens()).map((entry) => entry.userId)).not.toContain(rows[0]?.id);
  });

  it('creates the folder if needed and leaves no partial file behind', async () => {
    await write();

    expect(await fileExists(outFile)).toBe(true);
    expect(await fileExists(`${outFile}.partial`)).toBe(false);
  });

  it('refuses when there are no seeded fans, and writes nothing', async () => {
    const empty = 'tokens_empty_probe';
    const connectionString = schemaConnectionString(empty);
    await db.pool.query(`DROP SCHEMA IF EXISTS ${empty} CASCADE`);
    await db.pool.query(`CREATE SCHEMA ${empty}`);
    try {
      await runMigrations({ connectionString, logger, production: true });

      await expect(write({ connectionString })).rejects.toThrow(
        'No seeded fans found. Run npm run reset first.',
      );
      expect(await fileExists(outFile)).toBe(false);
    } finally {
      await db.pool.query(`DROP SCHEMA IF EXISTS ${empty} CASCADE`);
    }
  });

  it.each([
    [
      'a database that is not local',
      { connectionString: 'postgres://u:p@db.example.com/x' },
      /the database host db\.example\.com is not local/,
    ],
    [
      'a ?host= that points elsewhere',
      { connectionString: 'postgres://u:p@localhost/x?host=db.example.com' },
      /db\.example\.com is not local/,
    ],
    ['NODE_ENV=production', { nodeEnv: 'production' }, /NODE_ENV is production/],
  ])('refuses %s before connecting, and writes nothing', async (_case, overrides, message) => {
    await expect(write(overrides)).rejects.toThrow(message);
    expect(await fileExists(outFile)).toBe(false);
  });

  it('writes to loadtest/tokens.json at the repo root by default', () => {
    expect(path.relative(path.resolve(import.meta.dirname, '../..'), TOKENS_FILE)).toBe(
      path.join('loadtest', 'tokens.json'),
    );
  });
});

describe('every token authenticates against the API', { timeout: 30_000 }, () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const config = {
      NODE_ENV: 'test' as const,
      JWT_SECRET,
      JWT_EXPIRES_IN: LIFETIME_SECONDS,
      RACE_DELAY_MS: 0,
    };
    const holdStrategy = createHoldStrategy('lock', { db, holdSeconds: 300, logger });
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

  it('gets past requireAuth with each of the 1,000 tokens', async () => {
    await write();
    const tokens = await readTokens();

    // An empty body fails validation, which runs only after requireAuth has accepted the token.
    const statuses: number[] = [];
    for (let start = 0; start < tokens.length; start += 100) {
      const batch = tokens.slice(start, start + 100);
      statuses.push(
        ...(await Promise.all(
          batch.map(async ({ token }) => {
            const res = await fetch(`${baseUrl}/events/1/holds`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: '{}',
            });
            await res.arrayBuffer();
            return res.status;
          }),
        )),
      );
    }

    expect(statuses).toHaveLength(1_000);
    expect(statuses.filter((status) => status !== 400)).toEqual([]);
  });

  it('is refused by an API with a different secret', async () => {
    const other = 'other-tokens-secret-at-least-32-chars';
    const { count } = await writeTokens({
      connectionString: CONNECTION_STRING,
      nodeEnv: 'test',
      jwtSecret: other,
      expiresInSeconds: LIFETIME_SECONDS,
      logger,
      outFile,
    });
    const [first] = await readTokens();

    const res = await fetch(`${baseUrl}/events/1/holds`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${first?.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(count).toBe(1_000);
    expect(res.status).toBe(401);
  });
});
