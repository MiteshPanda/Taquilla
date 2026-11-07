import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createApiClient,
  HEALTH_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SEAT_READ_TIMEOUT_MS,
} from '../src/api/client.js';
import { ApiError, SERVER_ERROR_CODES } from '../src/api/errors.js';
import type { Call } from './helpers.js';
import { bodyOf, fakeFetch, json, stadium } from './helpers.js';

const BASE_URL = 'http://api.test/v1';

function signalOf(call: Call): AbortSignal {
  if (!call.init.signal) throw new Error('The client sent no signal.');
  return call.init.signal;
}

// Never answers, and fails with the signal's reason once it aborts, as a real fetch does.
function stall(call: Call): Promise<Response> {
  const signal = signalOf(call);
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

function headersOf(call: Call | undefined): Headers {
  return new Headers(call?.init.headers);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a successful answer', () => {
  it('GETs the path under the base URL and returns the body its schema parsed', async () => {
    const { calls, fetch } = fakeFetch(() => json(200, { status: 'ok' }));

    await expect(createApiClient({ baseUrl: BASE_URL, fetch }).health()).resolves.toEqual({
      status: 'ok',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://api.test/v1/health');
    expect(calls[0]?.init).toMatchObject({ method: 'GET', body: null });
    expect([...headersOf(calls[0])]).toEqual([['accept', 'application/json']]);
  });

  it('sends a JSON body, a bearer token and an idempotency key', async () => {
    const { calls, fetch } = fakeFetch(() => json(200, { orderId: 'o-1' }));
    const api = createApiClient({ baseUrl: BASE_URL, fetch });

    const order = await api.request('/holds/h-1/checkout', z.object({ orderId: z.string() }), {
      method: 'POST',
      body: { seatIds: [42, 43] },
      token: 'a.b.c',
      idempotencyKey: 'key-1',
    });

    expect(order).toEqual({ orderId: 'o-1' });
    expect(calls[0]?.init).toMatchObject({ method: 'POST', body: '{"seatIds":[42,43]}' });
    expect(Object.fromEntries(headersOf(calls[0]))).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: 'Bearer a.b.c',
      'idempotency-key': 'key-1',
    });
  });

  it('reads an answer with no body, such as a 204, as undefined', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl: BASE_URL, fetch });

    await expect(
      api.request('/holds/h-1', z.undefined(), { method: 'DELETE' }),
    ).resolves.toBeUndefined();
  });
});

describe('an error answer', () => {
  it('becomes an ApiError with its status, code, message, seats and request ID', async () => {
    const { fetch } = fakeFetch(() =>
      json(
        409,
        {
          error: {
            code: 'SEAT_TAKEN',
            message: 'Seat 42 was just taken. Pick another seat.',
            seatIds: [42],
          },
        },
        { 'X-Request-Id': 'req-1' },
      ),
    );
    const api = createApiClient({ baseUrl: BASE_URL, fetch });

    const err = await api.request('/events/1/holds', z.unknown()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'SEAT_TAKEN',
      message: 'Seat 42 was just taken. Pick another seat.',
      seatIds: [42],
      requestId: 'req-1',
    });
  });

  it('has no seats and no request ID when the answer names none', async () => {
    const { fetch } = fakeFetch(() =>
      json(404, { error: { code: 'NOT_FOUND', message: 'This route does not exist.' } }),
    );
    const api = createApiClient({ baseUrl: BASE_URL, fetch });

    await expect(api.request('/nowhere', z.unknown())).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      seatIds: [],
      requestId: undefined,
    });
  });

  it.each(SERVER_ERROR_CODES)('keeps the code %s', async (code) => {
    const { fetch } = fakeFetch(() => json(400, { error: { code, message: 'A message.' } }));
    const api = createApiClient({ baseUrl: BASE_URL, fetch });

    await expect(api.request('/x', z.unknown())).rejects.toMatchObject({ code });
  });
});

describe('an answer that is not the API’s', () => {
  it('reports an error page that is not JSON as BAD_RESPONSE, keeping its status', async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response('<h1>502 Bad Gateway</h1>', {
          status: 502,
          headers: { 'Content-Type': 'text/html', 'X-Request-Id': 'req-2' },
        }),
    );
    const api = createApiClient({ baseUrl: BASE_URL, fetch });

    const err = await api.request('/x', z.unknown()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 502,
      code: 'BAD_RESPONSE',
      message: 'Something went wrong. Please try again.',
      requestId: 'req-2',
    });
    expect((err as ApiError).cause).toBeInstanceOf(SyntaxError);
  });

  it.each([
    ['an unknown code', { error: { code: 'TEAPOT', message: 'I am a teapot.' } }],
    ['no message', { error: { code: 'NOT_FOUND' } }],
    [
      'seats that are not whole numbers',
      { error: { code: 'SEAT_TAKEN', message: 'm', seatIds: ['42'] } },
    ],
    ['no error object', { message: 'Not found' }],
  ])('reports an error body with %s as BAD_RESPONSE', async (_case, body) => {
    const { fetch } = fakeFetch(() => json(418, body));
    const api = createApiClient({ baseUrl: BASE_URL, fetch });

    await expect(api.request('/x', z.unknown())).rejects.toMatchObject({
      status: 418,
      code: 'BAD_RESPONSE',
    });
  });

  it('reports a success body its schema refuses as BAD_RESPONSE', async () => {
    const { fetch } = fakeFetch(() => json(200, { status: 'down' }));

    const err = await createApiClient({ baseUrl: BASE_URL, fetch })
      .health()
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 200, code: 'BAD_RESPONSE' });
    expect((err as ApiError).cause).toBeInstanceOf(z.ZodError);
  });

  it('reports a success body that is not JSON as BAD_RESPONSE', async () => {
    const { fetch } = fakeFetch(() => new Response('ok', { status: 200 }));

    await expect(createApiClient({ baseUrl: BASE_URL, fetch }).health()).rejects.toMatchObject({
      status: 200,
      code: 'BAD_RESPONSE',
    });
  });
});

describe('no answer', () => {
  it('reports a request that never reached the API as NETWORK_ERROR', async () => {
    const failure = new TypeError('Failed to fetch');
    const { fetch } = fakeFetch(() => Promise.reject(failure));

    const err = await createApiClient({ baseUrl: BASE_URL, fetch })
      .health()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
      message: "Can't reach Taquilla. Check your connection and try again.",
      cause: failure,
    });
  });

  it('reports no answer in time as TIMEOUT', async () => {
    const { fetch } = fakeFetch(stall);
    const api = createApiClient({ baseUrl: BASE_URL, fetch, timeoutMs: 20 });

    await expect(api.request('/x', z.unknown())).rejects.toMatchObject({
      status: 0,
      code: 'TIMEOUT',
      message: 'Taquilla took too long to answer. Try again.',
    });
  });

  it('cuts off an answer that stalls halfway through its body', async () => {
    const { fetch } = fakeFetch((call) => {
      const signal = signalOf(call);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":'));
          // A real fetch fails the body this way when its signal aborts.
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    });
    const api = createApiClient({ baseUrl: BASE_URL, fetch, timeoutMs: 20 });

    await expect(api.request('/x', z.unknown())).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('still times out when the caller passes its own signal', async () => {
    const { fetch } = fakeFetch(stall);
    const api = createApiClient({ baseUrl: BASE_URL, fetch, timeoutMs: 20 });

    await expect(
      api.request('/x', z.unknown(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('gives each request 30 seconds, the health check 5, and a caller its own choice', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { fetch } = fakeFetch(() => json(200, { status: 'ok' }));
    const api = createApiClient({ baseUrl: BASE_URL, fetch });

    await api.request('/x', z.unknown());
    await api.health();
    await api.request('/x', z.unknown(), { timeoutMs: 1_234 });

    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(HEALTH_TIMEOUT_MS).toBe(5_000);
    expect(timeout.mock.calls).toEqual([[30_000], [5_000], [1_234]]);
  });
});

describe("the caller's own cancel", () => {
  it('rejects with the reason the caller gave, not an ApiError', async () => {
    const { fetch } = fakeFetch(stall);
    const controller = new AbortController();
    const api = createApiClient({ baseUrl: BASE_URL, fetch });

    const pending = api.health(controller.signal).catch((e: unknown) => e);
    controller.abort();
    const err = await pending;

    expect(err).not.toBeInstanceOf(ApiError);
    expect(err).toBe(controller.signal.reason);
    expect(err).toMatchObject({ name: 'AbortError' });
  });

  it('passes on a cancel made before the request started', async () => {
    const { fetch } = fakeFetch((call) =>
      signalOf(call).aborted ? Promise.reject(signalOf(call).reason as Error) : stall(call),
    );
    const api = createApiClient({ baseUrl: BASE_URL, fetch });

    await expect(api.health(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('the auth calls', () => {
  const credentials = { email: 'fan7@taquilla.test', password: 'correct horse' };

  it('logs in with a POST to /auth/login and resolves with the token', async () => {
    const { calls, fetch } = fakeFetch(() => json(200, { token: 'a.b.c' }));

    await expect(createApiClient({ baseUrl: BASE_URL, fetch }).logIn(credentials)).resolves.toBe(
      'a.b.c',
    );

    expect(calls[0]?.url).toBe('http://api.test/v1/auth/login');
    expect(calls[0]?.init.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual(credentials);
    expect(headersOf(calls[0]).has('authorization')).toBe(false);
  });

  it('refuses a login answer without a token', async () => {
    const { fetch } = fakeFetch(() => json(200, { token: '' }));

    await expect(
      createApiClient({ baseUrl: BASE_URL, fetch }).logIn(credentials),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('signs up with a POST to /auth/signup and resolves with the new fan', async () => {
    const { calls, fetch } = fakeFetch(() => json(201, { id: 1001, email: credentials.email }));

    await expect(
      createApiClient({ baseUrl: BASE_URL, fetch }).signUp(credentials),
    ).resolves.toEqual({ id: 1001, email: credentials.email });

    expect(calls[0]?.url).toBe('http://api.test/v1/auth/signup');
    expect(calls[0]?.init.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual(credentials);
  });
});

describe('a refused token', () => {
  const REFUSED = { error: { code: 'UNAUTHORIZED', message: 'Log in again.' } };

  function client(answer: () => Response) {
    const onUnauthorized = vi.fn();
    const { fetch } = fakeFetch(answer);
    return { api: createApiClient({ baseUrl: BASE_URL, fetch, onUnauthorized }), onUnauthorized };
  }

  it('calls onUnauthorized once, then still rejects with the ApiError', async () => {
    const { api, onUnauthorized } = client(() => json(401, REFUSED));

    await expect(api.request('/orders/x', z.unknown(), { token: 'a.b.c' })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('calls it even when the 401 is not in the API’s shape', async () => {
    const { api, onUnauthorized } = client(() => new Response('Unauthorized', { status: 401 }));

    await expect(api.request('/orders/x', z.unknown(), { token: 'a.b.c' })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('is not called for a 401 to a request sent without a token, such as a wrong password', async () => {
    const { api, onUnauthorized } = client(() => json(401, REFUSED));

    await expect(
      api.logIn({ email: 'fan7@taquilla.test', password: 'wrong' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('is not called for any other refusal of a request with a token', async () => {
    const { api, onUnauthorized } = client(() =>
      json(404, { error: { code: 'NOT_FOUND', message: 'Not found.' } }),
    );

    await expect(api.request('/orders/x', z.unknown(), { token: 'a.b.c' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('the seat reads', () => {
  it('GETs the full map and parses every seat', async () => {
    const map = stadium({ rows: 1, seatsPerRow: 2 });
    const { calls, fetch } = fakeFetch(() => json(200, map));

    await expect(createApiClient({ baseUrl: BASE_URL, fetch }).seatMap(1)).resolves.toEqual(map);
    expect(calls[0]?.url).toBe('http://api.test/v1/events/1/seats');
  });

  it('GETs the seat states', async () => {
    const { calls, fetch } = fakeFetch(() => json(200, { held: [2], sold: [7, 8] }));

    await expect(createApiClient({ baseUrl: BASE_URL, fetch }).seatStates(1)).resolves.toEqual({
      held: [2],
      sold: [7, 8],
    });
    expect(calls[0]?.url).toBe('http://api.test/v1/events/1/seats/states');
  });

  it.each([
    [
      'a seat in an unknown state',
      {
        ...stadium({ rows: 1, seatsPerRow: 1 }),
        seats: [{ ...stadium({ rows: 1, seatsPerRow: 1 }).seats[0], state: 'reserved' }],
      },
    ],
    [
      'a price that is not whole paise',
      {
        ...stadium({ rows: 1, seatsPerRow: 1 }),
        seats: [{ ...stadium({ rows: 1, seatsPerRow: 1 }).seats[0], pricePaise: 4500.5 }],
      },
    ],
    ['no seats list', { event: stadium().event }],
  ])('refuses a map with %s', async (_case, body) => {
    const { fetch } = fakeFetch(() => json(200, body));

    await expect(createApiClient({ baseUrl: BASE_URL, fetch }).seatMap(1)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });

  it('gives each seat read 10 seconds, well before a stuck one would delay the next poll', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { fetch } = fakeFetch((call) =>
      json(
        200,
        call.url.endsWith('/states')
          ? { held: [], sold: [] }
          : stadium({ rows: 1, seatsPerRow: 1 }),
      ),
    );
    const api = createApiClient({ baseUrl: BASE_URL, fetch });

    await api.seatMap(1);
    await api.seatStates(1);

    expect(SEAT_READ_TIMEOUT_MS).toBe(10_000);
    expect(timeout.mock.calls).toEqual([[10_000], [10_000]]);
  });
});

describe('holds', () => {
  const HOLD = {
    holdId: '6f1c1e0e-6b1a-4a51-9a3e-2f0c1a7d9e11',
    seatIds: [41, 42],
    amountPaise: 900_000,
    expiresAt: '2026-11-07T12:05:00.000Z',
  };

  it('holds seats with a POST carrying the seats, the token and the key', async () => {
    const { calls, fetch } = fakeFetch(() => json(201, HOLD));

    await expect(
      createApiClient({ baseUrl: BASE_URL, fetch }).holdSeats(1, [42, 41], 'a.b.c', 'key-1'),
    ).resolves.toEqual(HOLD);

    expect(calls[0]?.url).toBe('http://api.test/v1/events/1/holds');
    expect(calls[0]?.init.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual({ seatIds: [42, 41] });
    expect(headersOf(calls[0]).get('authorization')).toBe('Bearer a.b.c');
    expect(headersOf(calls[0]).get('idempotency-key')).toBe('key-1');
  });

  it.each([
    ['a hold id that is not a UUID', { ...HOLD, holdId: 'h-1' }],
    ['an expiry that is not a time', { ...HOLD, expiresAt: 'soon' }],
    ['no seats', { ...HOLD, seatIds: [] }],
  ])('refuses a hold answer with %s', async (_case, body) => {
    const { fetch } = fakeFetch(() => json(201, body));

    await expect(
      createApiClient({ baseUrl: BASE_URL, fetch }).holdSeats(1, [41], 'a.b.c', 'key-1'),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('releases a hold with a DELETE carrying the token, and resolves on 204', async () => {
    const { calls, fetch } = fakeFetch(() => new Response(null, { status: 204 }));

    await expect(
      createApiClient({ baseUrl: BASE_URL, fetch }).releaseHold(HOLD.holdId, 'a.b.c'),
    ).resolves.toBeUndefined();

    expect(calls[0]?.url).toBe(`http://api.test/v1/holds/${HOLD.holdId}`);
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(headersOf(calls[0]).get('authorization')).toBe('Bearer a.b.c');
  });

  it('keeps a strange hold id inside its own path segment', async () => {
    const { calls, fetch } = fakeFetch(() => new Response(null, { status: 204 }));

    await createApiClient({ baseUrl: BASE_URL, fetch }).releaseHold('../orders/x', 'a.b.c');

    expect(calls[0]?.url).toBe('http://api.test/v1/holds/..%2Forders%2Fx');
  });
});

describe('checkout', () => {
  const ORDER = {
    orderId: '0b7c6c1a-2f4e-4d7b-8a62-3c9e5d1f7a20',
    holdId: '6f1c1e0e-6b1a-4a51-9a3e-2f0c1a7d9e11',
    status: 'paid',
    amountPaise: 900_000,
    createdAt: '2026-11-07T12:00:00.000Z',
    tickets: [
      { id: 1, seatId: 41, section: 'Lateral Este', row: 'B', number: 16, pricePaise: 450_000 },
      { id: 2, seatId: 42, section: 'Lateral Este', row: 'B', number: 17, pricePaise: 450_000 },
    ],
  };

  it('pays with a POST to the hold, carrying the token and the key, and no body', async () => {
    const { calls, fetch } = fakeFetch(() => json(200, ORDER));

    await expect(
      createApiClient({ baseUrl: BASE_URL, fetch }).checkout(ORDER.holdId, 'a.b.c', 'pay-1'),
    ).resolves.toEqual(ORDER);

    expect(calls[0]?.url).toBe(`http://api.test/v1/holds/${ORDER.holdId}/checkout`);
    expect(calls[0]?.init).toMatchObject({ method: 'POST', body: null });
    expect(headersOf(calls[0]).get('authorization')).toBe('Bearer a.b.c');
    expect(headersOf(calls[0]).get('idempotency-key')).toBe('pay-1');
  });

  it('keeps a strange hold id inside its own path segment', async () => {
    const { calls, fetch } = fakeFetch(() => json(200, ORDER));

    await createApiClient({ baseUrl: BASE_URL, fetch }).checkout('../orders/x', 'a.b.c', 'pay-1');

    expect(calls[0]?.url).toBe('http://api.test/v1/holds/..%2Forders%2Fx/checkout');
  });

  it.each([
    ['an unknown status', { ...ORDER, status: 'shipped' }],
    [
      'a ticket priced in fractions of paise',
      { ...ORDER, tickets: [{ ...ORDER.tickets[0], pricePaise: 1.5 }] },
    ],
    ['no tickets list', { ...ORDER, tickets: undefined }],
  ])('refuses an order with %s', async (_case, body) => {
    const { fetch } = fakeFetch(() => json(200, body));

    await expect(
      createApiClient({ baseUrl: BASE_URL, fetch }).checkout(ORDER.holdId, 'a.b.c', 'pay-1'),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});
