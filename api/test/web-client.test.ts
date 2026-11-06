// The web page's API client against the API's real app, error handler, CORS rules and auth routes,
// over HTTP. The client's own edge cases are in web/test/client.test.ts.
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router } from 'express';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { createApiClient } from '../../web/src/api/client.js';
import type { ApiClient } from '../../web/src/api/client.js';
import { ApiError } from '../../web/src/api/errors.js';
import type { ServerErrorCode } from '../../web/src/api/errors.js';
import { tokenExpiry } from '../../web/src/auth/session.js';
import { createApp } from '../src/app.js';
import { requireAuth, userIdOf } from '../src/auth/middleware.js';
import { createAuthRouter } from '../src/auth/routes.js';
import { signupSchema } from '../src/auth/rules.js';
import { createDatabase } from '../src/db.js';
import { AppError } from '../src/errors.js';
import type { ErrorCode } from '../src/errors.js';
import { createHealthRouter } from '../src/health/routes.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { schemaConnectionString } from './helpers/database.js';

// Sign-up and login each run one bcrypt hash at cost 12, which can take a second on a laptop.
vi.setConfig({ testTimeout: 30_000 });

const WEB_ORIGIN = 'http://localhost:5173';
const SCHEMA = 'web_client_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'test-secret-that-is-at-least-32-chars';
const TOKEN_SECONDS = 3600;
const logger = createLogger('silent');
const db = createDatabase({ connectionString: CONNECTION_STRING, logger });

const routes = Router();
routes.use(createHealthRouter({ ping: () => Promise.resolve() }));
routes.use(
  '/auth',
  createAuthRouter({ db, config: { JWT_SECRET, JWT_EXPIRES_IN: TOKEN_SECONDS } }),
);
routes.get('/test/me', requireAuth(JWT_SECRET), (req, res) => {
  res.json({ userId: userIdOf(req) });
});
routes.post('/test/echo', (req, res) => {
  res.status(201).json({
    body: req.body as unknown,
    authorization: req.get('Authorization'),
    idempotencyKey: req.get('Idempotency-Key'),
  });
});
routes.get('/test/seat-taken', () => {
  throw new AppError(409, 'SEAT_TAKEN', 'Seat 42 was just taken. Pick another seat.', {
    seatIds: [42],
  });
});
routes.get('/test/crash', () => {
  throw new Error('boom');
});

let server: Server;
let baseUrl: string;
let api: ApiClient;
const onUnauthorized = vi.fn();

beforeAll(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });

  const app = createApp({ config: { CORS_ORIGINS: [WEB_ORIGIN] }, logger, routes });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // No fetch passed, so this is the client's own default, as the page uses it.
  api = createApiClient({ baseUrl, onUnauthorized });
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('the web client against the real API', () => {
  it('knows exactly the error codes the server sends', () => {
    // Checked by `npm run typecheck`: a code added to or dropped from either side fails it.
    expectTypeOf<ServerErrorCode>().toEqualTypeOf<ErrorCode>();
  });

  it('calls /health', async () => {
    await expect(api.health()).resolves.toEqual({ status: 'ok' });
  });

  it("sends a body, token and key that the server's parser reads", async () => {
    const echo = await api.request(
      '/test/echo',
      z.object({ body: z.unknown(), authorization: z.string(), idempotencyKey: z.string() }),
      { method: 'POST', body: { seatIds: [42, 43] }, token: 'a.b.c', idempotencyKey: 'key-1' },
    );

    expect(echo).toEqual({
      body: { seatIds: [42, 43] },
      authorization: 'Bearer a.b.c',
      idempotencyKey: 'key-1',
    });
  });

  it("turns the server's error into an ApiError with its seats and request ID", async () => {
    const err = await api.request('/test/seat-taken', z.unknown()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'SEAT_TAKEN',
      message: 'Seat 42 was just taken. Pick another seat.',
      seatIds: [42],
      requestId: expect.stringMatching(/^[\w-]{1,128}$/) as unknown,
    });
  });

  it('turns an unknown route into NOT_FOUND and a crash into INTERNAL_ERROR', async () => {
    await expect(api.request('/nowhere', z.unknown())).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      seatIds: [],
    });
    await expect(api.request('/test/crash', z.unknown())).rejects.toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
    });
  });

  it('is allowed by CORS to send its headers and read the request ID from the web origin', async () => {
    const preflight = await fetch(`${baseUrl}/test/echo`, {
      method: 'OPTIONS',
      headers: {
        Origin: WEB_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'accept,authorization,content-type,idempotency-key',
      },
    });
    const allowed = preflight.headers.get('Access-Control-Allow-Headers')?.toLowerCase() ?? '';

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(WEB_ORIGIN);
    for (const header of ['authorization', 'content-type', 'idempotency-key']) {
      expect(allowed).toContain(header);
    }

    // A browser hides every response header CORS doesn't expose, so the request ID must be.
    const health = await fetch(`${baseUrl}/health`, { headers: { Origin: WEB_ORIGIN } });
    expect(health.headers.get('Access-Control-Expose-Headers')).toMatch(/X-Request-Id/i);
  });
});

describe('the web client against the real auth routes', () => {
  const credentials = { email: 'web@taquilla.test', password: 'correct horse' };
  const me = z.object({ userId: z.number() });

  it('signs up and logs in, with a token the API accepts and the page can read', async () => {
    const fan = await api.signUp(credentials);
    const token = await api.logIn(credentials);

    expect(fan).toEqual({ id: expect.any(Number) as unknown, email: credentials.email });
    // The page logs out on time by reading the token's own expiry.
    expect(Math.abs((tokenExpiry(token) ?? 0) - (Date.now() + TOKEN_SECONDS * 1000))).toBeLessThan(
      5_000,
    );
    await expect(api.request('/test/me', me, { token })).resolves.toEqual({ userId: fan.id });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("refuses what the forms refuse, in the forms' words, since both use the same rules", async () => {
    const tooLong = { email: 'long@taquilla.test', password: '€'.repeat(25) };
    const formMessage = signupSchema.safeParse(tooLong).error?.issues[0]?.message;

    await expect(api.signUp(tooLong)).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: formMessage,
    });
    expect(formMessage).toBe('Use a password of at least 8 characters and at most 72 bytes.');
  });

  it('answers a wrong password with a 401 that leaves the session alone', async () => {
    await expect(api.logIn({ ...credentials, password: 'wrong password' })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('reports a refused token to onUnauthorized, so the page can end the session', async () => {
    const forged = `${(await api.logIn(credentials)).slice(0, -2)}xx`;

    await expect(api.request('/test/me', me, { token: forged })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
