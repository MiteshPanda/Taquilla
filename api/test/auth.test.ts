import bcrypt from 'bcryptjs';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { requireAuth, userIdOf } from '../src/auth/middleware.js';
import { BCRYPT_COST, DUMMY_HASH } from '../src/auth/password.js';
import { createAuthRouter } from '../src/auth/routes.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { schemaConnectionString } from './helpers/database.js';

const SCHEMA = 'auth_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'test-secret-that-is-at-least-32-chars';
const TOKEN_SECONDS = 3600;
const EMAIL = 'fan@taquilla.test';
const PASSWORD = 'correct horse battery';

const logger = createLogger('silent');
const INCORRECT = {
  error: { code: 'UNAUTHORIZED', message: 'The email or password is incorrect.' },
};
const SESSION_INVALID = {
  error: { code: 'UNAUTHORIZED', message: 'Your session is invalid or has expired. Log in again.' },
};
const LOG_IN_FIRST = { error: { code: 'UNAUTHORIZED', message: 'Log in to continue.' } };

let db: Database;
let app: ReturnType<typeof createApp>;

// A fresh app per test, so each one starts with an empty rate-limit counter.
function buildApp(): ReturnType<typeof createApp> {
  const routes = Router();
  routes.use(
    '/auth',
    createAuthRouter({ db, config: { JWT_SECRET, JWT_EXPIRES_IN: TOKEN_SECONDS } }),
  );
  routes.get('/me', requireAuth(JWT_SECRET), (req, res) => {
    res.json({ userId: userIdOf(req) });
  });
  routes.get('/forgot-auth', (req, res) => {
    res.json({ userId: userIdOf(req) });
  });
  routes.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  return createApp({ config: { CORS_ORIGINS: [] }, logger, routes });
}

function post(path: string, body?: object) {
  const req = request(app).post(path);
  return body === undefined ? req : req.send(body);
}

function signUp(body?: object) {
  return post('/auth/signup', body);
}

function logIn(body?: object) {
  return post('/auth/login', body);
}

function me(authorization?: string) {
  const req = request(app).get('/me');
  return authorization === undefined ? req : req.set('Authorization', authorization);
}

async function createFan(email = EMAIL, password = PASSWORD): Promise<number> {
  const res = await signUp({ email, password }).expect(201);
  return (res.body as { id: number }).id;
}

function tokenFor(userId: number, options: jwt.SignOptions = {}, secret = JWT_SECRET): string {
  return jwt.sign({}, secret, {
    algorithm: 'HS256',
    subject: String(userId),
    expiresIn: 60,
    ...options,
  });
}

async function elapsedMs(send: () => Promise<unknown>): Promise<number> {
  const startedAt = performance.now();
  await send();
  return performance.now() - startedAt;
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
});

beforeEach(async () => {
  await db.pool.query('TRUNCATE users CASCADE');
  app = buildApp();
});

afterAll(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('POST /auth/signup', () => {
  it('creates an account and stores only a bcrypt hash of the password', async () => {
    const res = await signUp({ email: EMAIL, password: PASSWORD }).expect(201);

    expect(res.body).toEqual({ id: expect.any(Number) as number, email: EMAIL });
    const { rows } = await db.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE email = $1',
      [EMAIL],
    );
    const hash = rows[0]?.password_hash ?? '';
    expect(hash).not.toContain(PASSWORD);
    expect(bcrypt.getRounds(hash)).toBe(12);
    expect(await bcrypt.compare(PASSWORD, hash)).toBe(true);
  });

  it('trims and lowercases the email', async () => {
    const res = await signUp({ email: '  Fan@Taquilla.TEST ', password: PASSWORD }).expect(201);

    expect(res.body).toMatchObject({ email: EMAIL });
  });

  it.each([
    ['the same email', EMAIL],
    ['the same email in other letter case', 'FAN@taquilla.test'],
  ])('rejects %s with 409 EMAIL_TAKEN', async (_name, email) => {
    await createFan();

    const res = await signUp({ email, password: 'another password' }).expect(409);

    expect(res.body).toEqual({
      error: {
        code: 'EMAIL_TAKEN',
        message: 'An account with this email already exists. Log in instead.',
      },
    });
  });

  it('creates one account when the same email signs up five times at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => signUp({ email: EMAIL, password: PASSWORD })),
    );

    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409, 409, 409]);
    const { rows } = await db.pool.query('SELECT 1 FROM users');
    expect(rows).toHaveLength(1);
  });

  it('accepts a password of exactly 72 bytes', async () => {
    await signUp({ email: EMAIL, password: 'a'.repeat(72) }).expect(201);
  });

  const PASSWORD_RULE = 'Use a password of at least 8 characters and at most 72 bytes.';
  it.each([
    ['no body', undefined, 'Send a JSON body with an email and a password.'],
    ['a missing email', { password: PASSWORD }, 'Enter a valid email address.'],
    [
      'an invalid email',
      { email: 'not-an-email', password: PASSWORD },
      'Enter a valid email address.',
    ],
    [
      'an email over 254 characters',
      { email: `${'a'.repeat(250)}@x.io`, password: PASSWORD },
      'Enter a valid email address.',
    ],
    ['a missing password', { email: EMAIL }, PASSWORD_RULE],
    ['a password of 7 characters', { email: EMAIL, password: 'a'.repeat(7) }, PASSWORD_RULE],
    ['a password of 73 bytes', { email: EMAIL, password: 'a'.repeat(73) }, PASSWORD_RULE],
    // 37 characters but 74 bytes: the limit is bytes, because that is what bcrypt counts.
    ['37 two-byte characters', { email: EMAIL, password: 'é'.repeat(37) }, PASSWORD_RULE],
  ])('rejects %s with 400', async (_name, body, message) => {
    const res = await signUp(body).expect(400);

    expect(res.body).toEqual({ error: { code: 'VALIDATION_FAILED', message } });
  });
});

describe('POST /auth/login', () => {
  it('returns a JWT for the account, signed with HS256 and expiring after JWT_EXPIRES_IN', async () => {
    const userId = await createFan();

    const res = await logIn({ email: EMAIL, password: PASSWORD }).expect(200);

    const { token } = res.body as { token: string };
    const decoded = jwt.verify(token, JWT_SECRET, { complete: true });
    const payload = decoded.payload as jwt.JwtPayload;
    expect(decoded.header.alg).toBe('HS256');
    expect(payload.sub).toBe(String(userId));
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(TOKEN_SECONDS);
  });

  it('accepts the email in any letter case', async () => {
    await createFan();

    await logIn({ email: ' FAN@taquilla.test', password: PASSWORD }).expect(200);
  });

  it('logs in a seeded fan whose hash came from the shared seed hash', async () => {
    const hash = await bcrypt.hash('taquilla-dev', BCRYPT_COST);
    await db.pool.query(
      `INSERT INTO users (email, password_hash) VALUES ('fan1@taquilla.test', $1)`,
      [hash],
    );

    await logIn({ email: 'fan1@taquilla.test', password: 'taquilla-dev' }).expect(200);
  });

  it('gives a wrong password and an unknown email the same 401', async () => {
    await createFan();

    const wrongPassword = await logIn({ email: EMAIL, password: 'wrong password' }).expect(401);
    const unknownEmail = await logIn({ email: 'nobody@taquilla.test', password: PASSWORD }).expect(
      401,
    );

    expect(wrongPassword.body).toEqual(INCORRECT);
    expect(unknownEmail.body).toEqual(INCORRECT);
  });

  it('takes about as long for an unknown email as for a wrong password', async () => {
    await createFan();
    const wrong: number[] = [];
    const unknown: number[] = [];

    for (let i = 0; i < 3; i += 1) {
      wrong.push(await elapsedMs(() => logIn({ email: EMAIL, password: 'wrong password' })));
      unknown.push(await elapsedMs(() => logIn({ email: 'nobody@taquilla.test', password: 'x' })));
    }

    // Without the dummy hash, an unknown email answers in a few milliseconds instead of ~250.
    const median = (times: number[]) => [...times].sort((a, b) => a - b)[1] ?? 0;
    expect(median(unknown)).toBeGreaterThan(median(wrong) * 0.5);
  });

  it('rejects a password that only matches because bcrypt ignores bytes after 72', async () => {
    const password = 'a'.repeat(72);
    await createFan(EMAIL, password);

    const res = await logIn({ email: EMAIL, password: `${password}extra` }).expect(401);

    expect(res.body).toEqual(INCORRECT);
  });

  it.each([
    ['no body', undefined, 'Send a JSON body with an email and a password.'],
    ['a missing password', { email: EMAIL }, 'Enter your password.'],
    ['an empty password', { email: EMAIL, password: '' }, 'Enter your password.'],
    ['an invalid email', { email: 'nope', password: PASSWORD }, 'Enter a valid email address.'],
  ])('rejects %s with 400', async (_name, body, message) => {
    const res = await logIn(body).expect(400);

    expect(res.body).toEqual({ error: { code: 'VALIDATION_FAILED', message } });
  });
});

describe('requireAuth', () => {
  it('lets a valid token through and gives the route its user id', async () => {
    const userId = await createFan();
    const res = await logIn({ email: EMAIL, password: PASSWORD });
    const { token } = res.body as { token: string };

    await me(`Bearer ${token}`).expect(200, { userId });
    await me(`bearer ${token}`).expect(200, { userId });
  });

  it.each([
    ['no Authorization header', undefined],
    ['an empty header', ''],
    ['another scheme', 'Basic ZmFuOnBhc3N3b3Jk'],
    ['a bearer with no token', 'Bearer '],
    ['something that is not a JWT', 'Bearer not-a-jwt'],
  ])('rejects %s with 401', async (_name, header) => {
    const res = await me(header).expect(401);

    expect(res.body).toEqual(LOG_IN_FIRST);
  });

  it('rejects an expired token', async () => {
    const expired = tokenFor(1, { expiresIn: -10 });

    const res = await me(`Bearer ${expired}`).expect(401);

    expect(res.body).toEqual(SESSION_INVALID);
  });

  it('rejects a token whose payload was changed', async () => {
    const [header, , signature] = tokenFor(1).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: '2', exp: 9_999_999_999 })).toString(
      'base64url',
    );

    const res = await me(`Bearer ${header}.${forged}.${signature}`).expect(401);

    expect(res.body).toEqual(SESSION_INVALID);
  });

  it.each([
    ['another secret', () => tokenFor(1, {}, 'a-different-secret-of-32-characters')],
    ['another HMAC algorithm', () => tokenFor(1, { algorithm: 'HS512' })],
    [
      'algorithm none',
      () =>
        `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
          JSON.stringify({ sub: '1', exp: 9_999_999_999 }),
        ).toString('base64url')}.`,
    ],
    ['no expiry', () => jwt.sign({}, JWT_SECRET, { algorithm: 'HS256', subject: '1' })],
    [
      'a subject that is not a user id',
      () => jwt.sign({}, JWT_SECRET, { subject: 'admin', expiresIn: 60 }),
    ],
  ])('rejects a token signed with %s', async (_name, makeToken) => {
    const token = makeToken();

    const res = await me(`Bearer ${token}`).expect(401);

    // "none" leaves the signature empty, so it fails the shape check before verification.
    expect([SESSION_INVALID, LOG_IN_FIRST]).toContainEqual(res.body);
  });

  it('answers 401 when a route reads the user without requireAuth', async () => {
    await request(app).get('/forgot-auth').expect(401, LOG_IN_FIRST);
  });
});

describe('rate limit on /auth', () => {
  it('allows 10 requests a minute per IP, then answers 429 with Retry-After', async () => {
    for (let i = 0; i < 10; i += 1) {
      await logIn({}).expect(400);
    }

    const res = await logIn({ email: EMAIL, password: PASSWORD }).expect(429);

    expect(res.body).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute, then try again.' },
    });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts signup and login together', async () => {
    for (let i = 0; i < 5; i += 1) {
      await logIn({}).expect(400);
      await signUp({}).expect(400);
    }

    await signUp({ email: EMAIL, password: PASSWORD }).expect(429);
  });

  it('leaves routes outside /auth alone', async () => {
    for (let i = 0; i < 11; i += 1) {
      await logIn({});
    }

    await request(app).get('/health').expect(200);
  });
});

describe('the dummy hash', () => {
  it('uses the same cost as real accounts, so it takes as long to check', () => {
    expect(bcrypt.getRounds(DUMMY_HASH)).toBe(BCRYPT_COST);
  });
});
