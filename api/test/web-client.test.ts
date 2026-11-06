// The web page's API client against the API's real app, error handler and CORS rules, over HTTP.
// The client's own edge cases are in web/test/client.test.ts.
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router } from 'express';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { createApiClient } from '../../web/src/api/client.js';
import type { ApiClient } from '../../web/src/api/client.js';
import { ApiError } from '../../web/src/api/errors.js';
import type { ServerErrorCode } from '../../web/src/api/errors.js';
import { createApp } from '../src/app.js';
import { AppError } from '../src/errors.js';
import type { ErrorCode } from '../src/errors.js';
import { createHealthRouter } from '../src/health/routes.js';
import { createLogger } from '../src/logger.js';

const WEB_ORIGIN = 'http://localhost:5173';

const routes = Router();
routes.use(createHealthRouter({ ping: () => Promise.resolve() }));
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

beforeAll(async () => {
  const app = createApp({
    config: { CORS_ORIGINS: [WEB_ORIGIN] },
    logger: createLogger('silent'),
    routes,
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // No fetch passed, so this is the client's own default, as the page uses it.
  api = createApiClient({ baseUrl });
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
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
