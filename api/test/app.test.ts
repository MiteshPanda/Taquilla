import { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { AppError } from '../src/errors.js';
import { createLogger } from '../src/logger.js';

interface LogLine {
  level: number;
  msg: string;
  err?: { message: string; stack: string };
  req: { id: string; url: string; headers: Record<string, string> };
  res: { statusCode: number };
}

const LEVEL = { debug: 20, info: 30, error: 50 };
const ALLOWED_ORIGIN = 'https://seats.example';
const INTERNAL_DETAIL = 'connection to 10.0.0.5 failed';

const routes = Router();
routes.get('/ok', (_req, res) => {
  res.json({ ok: true });
});
routes.get('/items/:id', (_req, res) => {
  res.json({ ok: true });
});
routes.post('/echo', (req, res) => {
  res.json(req.body);
});
routes.get('/seat-taken', () => {
  throw new AppError(409, 'SEAT_TAKEN', 'Seat 42 was just taken. Pick another seat.', {
    seatIds: [42],
  });
});
routes.get('/not-yours', () => {
  throw new AppError(404, 'NOT_FOUND', 'Hold not found.');
});
routes.get('/provider-down', () => {
  throw new AppError(
    503,
    'PAYMENT_UNAVAILABLE',
    'Payment is unavailable. Retry with the same key.',
  );
});
routes.get('/throws', () => {
  throw new Error(INTERNAL_DETAIL);
});
routes.get('/rejects', async () => {
  await Promise.resolve();
  throw new Error(INTERNAL_DETAIL);
});
routes.get('/throws-string', () => {
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw INTERNAL_DETAIL;
});
routes.get('/fails-mid-response', (_req, res) => {
  res.write('partial');
  throw new Error(INTERNAL_DETAIL);
});

let logs: LogLine[];

function buildApp() {
  const logger = createLogger('debug', {
    write: (line: string) => logs.push(JSON.parse(line) as LogLine),
  });
  return createApp({ config: { CORS_ORIGINS: [ALLOWED_ORIGIN] }, logger, routes });
}

// A request is logged when its response finishes, which can land just after the client returns.
async function logFor(url: string): Promise<LogLine> {
  return vi.waitFor(() => {
    const line = logs.find((entry) => entry.req?.url === url);
    if (!line) throw new Error(`no log line for ${url}`);
    return line;
  });
}

beforeEach(() => {
  logs = [];
});

describe('error rendering', () => {
  it('renders an AppError in the error shape, with its seatIds', async () => {
    const res = await request(buildApp()).get('/seat-taken');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'SEAT_TAKEN',
        message: 'Seat 42 was just taken. Pick another seat.',
        seatIds: [42],
      },
    });
  });

  it('leaves out seatIds when no seat caused the error', async () => {
    const res = await request(buildApp()).get('/not-yours');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Hold not found.' } });
  });

  it('keeps the message of a 5xx AppError and logs it as an error', async () => {
    const res = await request(buildApp()).get('/provider-down');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: {
        code: 'PAYMENT_UNAVAILABLE',
        message: 'Payment is unavailable. Retry with the same key.',
      },
    });
    expect((await logFor('/provider-down')).level).toBe(LEVEL.error);
  });

  it.each(['/throws', '/rejects', '/throws-string'])(
    'turns an unexpected error from %s into a generic 500 and logs the real one',
    async (url) => {
      const res = await request(buildApp()).get(url);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
      });
      expect(res.text).not.toContain(INTERNAL_DETAIL);
      expect(res.text).not.toContain('at ');

      const line = await logFor(url);
      expect(line.level).toBe(LEVEL.error);
      expect(line.err?.message).toBe(INTERNAL_DETAIL);
      expect(line.err?.stack).toEqual(expect.any(String));
    },
  );

  it('cuts off a response that fails after it has started, and logs the error', async () => {
    await expect(request(buildApp()).get('/fails-mid-response')).rejects.toThrow();

    const line = await logFor('/fails-mid-response');
    expect(line.level).toBe(LEVEL.error);
    expect(line.err?.message).toBe(INTERNAL_DETAIL);
  });

  it('answers an unknown route with 404 NOT_FOUND', async () => {
    const res = await request(buildApp()).get('/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'This route does not exist.' },
    });
  });

  it('answers a malformed path with 400, not 500', async () => {
    const res = await request(buildApp()).get('/items/%E0%A4%A');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'The request is invalid.' },
    });
  });
});

describe('JSON bodies', () => {
  const post = () => request(buildApp()).post('/echo').set('Content-Type', 'application/json');

  it('accepts a body under 10 kB', async () => {
    const body = { padding: 'x'.repeat(9 * 1024) };
    const res = await post().send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
  });

  it('rejects a body over 10 kB with 400 VALIDATION_FAILED', async () => {
    const res = await post().send({ padding: 'x'.repeat(11 * 1024) });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'The request body is too large.' },
    });
  });

  it('rejects malformed JSON with 400 VALIDATION_FAILED and no parser detail', async () => {
    const res = await post().send('{"seatIds": [41,');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'The request body is not valid JSON.' },
    });
  });
});

describe('request IDs', () => {
  it('generates an ID, echoes it and logs it', async () => {
    const res = await request(buildApp()).get('/ok');

    expect(res.headers['x-request-id']).toMatch(/^[\w-]{36}$/);
    expect((await logFor('/ok')).req.id).toBe(res.headers['x-request-id']);
  });

  it('keeps a safe ID sent by the client', async () => {
    const res = await request(buildApp()).get('/ok').set('X-Request-Id', 'client-id_1');

    expect(res.headers['x-request-id']).toBe('client-id_1');
    expect((await logFor('/ok')).req.id).toBe('client-id_1');
  });

  it('replaces an unsafe ID sent by the client', async () => {
    const res = await request(buildApp()).get('/ok').set('X-Request-Id', 'bad id {"level":60}');

    expect(res.headers['x-request-id']).toMatch(/^[\w-]{36}$/);
  });

  it('echoes the ID on error responses too', async () => {
    const res = await request(buildApp()).get('/throws').set('X-Request-Id', 'trace-me');

    expect(res.headers['x-request-id']).toBe('trace-me');
  });
});

describe('logging', () => {
  it('redacts the Authorization and Cookie headers', async () => {
    await request(buildApp())
      .get('/ok')
      .set('Authorization', 'Bearer secret-token')
      .set('Cookie', 'session=secret-cookie');

    const line = await logFor('/ok');
    expect(line.req.headers.authorization).toBe('[Redacted]');
    expect(line.req.headers.cookie).toBe('[Redacted]');
    expect(JSON.stringify(logs)).not.toContain('secret-');
  });

  it('redacts passwords and tokens in logged objects', () => {
    const logger = createLogger('info', {
      write: (line: string) => logs.push(JSON.parse(line) as LogLine),
    });

    logger.info({ password: 'hunter2', user: { password: 'hunter2', token: 'abc123' } }, 'login');

    const output = JSON.stringify(logs);
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('abc123');
  });

  it('writes one line per request', async () => {
    await request(buildApp()).get('/ok');

    await logFor('/ok');
    expect(logs).toHaveLength(1);
  });

  it('logs an expected 409 at debug and a normal request at info', async () => {
    const app = buildApp();
    await request(app).get('/seat-taken');
    await request(app).get('/ok');

    expect((await logFor('/seat-taken')).level).toBe(LEVEL.debug);
    expect((await logFor('/ok')).level).toBe(LEVEL.info);
  });
});

describe('security headers and CORS', () => {
  it('sets helmet headers and hides Express', async () => {
    const res = await request(buildApp()).get('/ok');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows a listed origin and exposes the request ID to it', async () => {
    const res = await request(buildApp()).get('/ok').set('Origin', ALLOWED_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-expose-headers']).toBe('X-Request-Id');
  });

  it('does not allow any other origin', async () => {
    const res = await request(buildApp()).get('/ok').set('Origin', 'https://evil.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight from a listed origin', async () => {
    const res = await request(buildApp())
      .options('/echo')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Idempotency-Key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toBe('Idempotency-Key');
  });
});
