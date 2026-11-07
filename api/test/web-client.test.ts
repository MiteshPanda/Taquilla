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
import { createSeatsRouter } from '../src/seats/routes.js';
import { createHoldsRouter } from '../src/holds/routes.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import { signToken } from '../src/auth/tokens.js';
import { takenMessage } from '../../web/src/seats/seats.js';
import { payHold } from '../../web/src/checkout/pay.js';
import type { Pool } from 'pg';
import type { Faults } from '../../payments-mock/src/faults.js';
import { createTestSchema, startMock } from '../../payments-mock/test/helpers/mock.js';
import type { RunningMock } from '../../payments-mock/test/helpers/mock.js';
import { createCheckoutRouter } from '../src/checkout/routes.js';
import { createPaymentClient } from '../src/checkout/payment-client.js';
import type { PaymentClient } from '../src/checkout/payment-client.js';
import { seedStadium } from '../src/seed.js';
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
const PAYMENTS_SCHEMA = 'web_client_payments';

// The provider, through the real mock. Each key's first charge attempt takes 300 ms, so a second
// click arrives while the first is still being paid.
const provider = { decline: false };
const faults: Faults = {
  delay: () => new Promise((resolve) => setTimeout(resolve, 300)),
  decline: () => provider.decline,
  loseResponse: () => false,
};
let mockPool: Pool;
let mock: RunningMock;
let realPayments: PaymentClient | undefined;
// The routes are built before the mock starts, so this hands calls on to it.
const payments: PaymentClient = {
  charge: (charge, context) => {
    if (realPayments === undefined) throw new Error('The payment mock is not running.');
    return realPayments.charge(charge, context);
  },
  refund: (key, context) => {
    if (realPayments === undefined) throw new Error('The payment mock is not running.');
    return realPayments.refund(key, context);
  },
};

const routes = Router();
routes.use(createHealthRouter({ ping: () => Promise.resolve() }));
routes.use(
  '/auth',
  createAuthRouter({ db, config: { JWT_SECRET, JWT_EXPIRES_IN: TOKEN_SECONDS } }),
);
routes.use(createSeatsRouter({ db }));
routes.use(
  createHoldsRouter({
    db,
    holdStrategy: createHoldStrategy('lock', { db, holdSeconds: 300, logger }),
    config: { JWT_SECRET },
  }),
);
routes.use(createCheckoutRouter({ db, payments, config: { JWT_SECRET } }));
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
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
  mockPool = await createTestSchema(PAYMENTS_SCHEMA);
  mock = await startMock(mockPool, faults);
  realPayments = createPaymentClient({ baseUrl: mock.url, logger, wait: () => Promise.resolve() });

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
  await mock.close();
  await mockPool.query(`DROP SCHEMA IF EXISTS ${PAYMENTS_SCHEMA} CASCADE`);
  await mockPool.end();
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

describe('the web client against the real seat routes', () => {
  it("parses the seed's whole map, and the states the page polls", async () => {
    const map = await api.seatMap(1);

    expect(map.seats).toHaveLength(2_000);
    expect(map.seats[0]).toMatchObject({ section: 'Fondo Norte', row: 'A', number: 1 });
    await expect(api.seatStates(1)).resolves.toEqual({ held: [], sold: [] });

    await db.pool.query(`UPDATE seats SET status = 'sold' WHERE id = ANY($1)`, [[42, 7]]);
    try {
      await expect(api.seatStates(1)).resolves.toEqual({ held: [], sold: [7, 42] });
    } finally {
      await db.pool.query(`UPDATE seats SET status = 'available' WHERE id = ANY($1)`, [[42, 7]]);
    }
  });

  it('gets NOT_FOUND for an event that does not exist', async () => {
    await expect(api.seatStates(999)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(api.seatMap(999)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('the web client against the real holds routes', () => {
  // Seeded fans 1 and 2, each in their own browser.
  const fanOne = () => signToken(1, JWT_SECRET, TOKEN_SECONDS);
  const fanTwo = () => signToken(2, JWT_SECRET, TOKEN_SECONDS);

  it('gives a seat two fans race for to one of them, and the other a message naming it', async () => {
    const results = await Promise.allSettled([
      api.holdSeats(1, [9], fanOne(), 'race-one'),
      api.holdSeats(1, [9], fanTwo(), 'race-two'),
    ]);

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const error: unknown = lost[0]?.reason;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'SEAT_TAKEN', seatIds: [9] });

    // What the losing page shows, from the seat the 409 named.
    const { seats } = await api.seatMap(1);
    const named = seats.filter((seat) => (error as ApiError).seatIds.includes(seat.id));
    expect(takenMessage(named)).toBe('Someone just took A-9 in Lateral Este. Pick another seat.');

    const hold = won[0]?.value;
    if (hold === undefined) throw new Error('no winner');
    const winner = results[0]?.status === 'fulfilled' ? fanOne() : fanTwo();
    await expect(api.seatStates(1)).resolves.toEqual({ held: [9], sold: [] });
    await api.releaseHold(hold.holdId, winner);
    await expect(api.seatStates(1)).resolves.toEqual({ held: [], sold: [] });
  });

  it('answers a retried hold with the same key with the same hold', async () => {
    const first = await api.holdSeats(1, [10, 11], fanOne(), 'retry-key');
    const again = await api.holdSeats(1, [10, 11], fanOne(), 'retry-key');

    expect(again).toEqual(first);
    expect(Date.parse(first.expiresAt)).toBeGreaterThan(Date.now());
    await api.releaseHold(first.holdId, fanOne());
  });

  it("refuses to release someone else's hold, with the same 404 as an unknown one", async () => {
    const hold = await api.holdSeats(1, [12], fanOne(), 'own-key');

    await expect(api.releaseHold(hold.holdId, fanTwo())).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    await api.releaseHold(hold.holdId, fanOne());
  });
});

describe('the web client against the real checkout and payment provider', () => {
  const fan = () => signToken(1, JWT_SECRET, TOKEN_SECONDS);
  const shortWait = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

  async function charges(): Promise<string[]> {
    const { rows } = await mockPool.query<{ status: string }>(
      'SELECT status FROM charges ORDER BY created_at',
    );
    return rows.map((row) => row.status);
  }

  it('charges a double-clicked Pay once, and both clicks end with the same paid order', async () => {
    const hold = await api.holdSeats(1, [13, 14], fan(), 'checkout-hold');
    const before = (await charges()).length;

    // Two clicks, one key, at once: the second waits out 409 REQUEST_IN_PROGRESS.
    const [first, second] = await Promise.all([
      payHold(api, hold.holdId, fan(), 'pay-once', { wait: shortWait }),
      payHold(api, hold.holdId, fan(), 'pay-once', { wait: shortWait }),
    ]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      holdId: hold.holdId,
      status: 'paid',
      amountPaise: 900_000,
      tickets: [{ seatId: 13 }, { seatId: 14 }],
    });
    expect((await charges()).slice(before)).toEqual(['succeeded']);
    expect((await api.seatStates(1)).sold).toEqual(expect.arrayContaining([13, 14]) as unknown);
  });

  it('pays under a new key after a decline, with one successful charge', async () => {
    const hold = await api.holdSeats(1, [15], fan(), 'decline-hold');
    const before = (await charges()).length;

    provider.decline = true;
    await expect(payHold(api, hold.holdId, fan(), 'pay-declined')).rejects.toMatchObject({
      status: 402,
      code: 'PAYMENT_DECLINED',
    });
    provider.decline = false;
    const paid = await payHold(api, hold.holdId, fan(), 'pay-again');

    expect(paid.status).toBe('paid');
    expect((await charges()).slice(before)).toEqual(['declined', 'succeeded']);
  });
});
