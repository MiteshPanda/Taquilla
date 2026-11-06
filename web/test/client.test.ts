import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApiClient, HEALTH_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '../src/api/client.js';
import type { Fetch } from '../src/api/client.js';
import { ApiError, SERVER_ERROR_CODES } from '../src/api/errors.js';

const BASE_URL = 'http://api.test/v1';

interface Call {
  url: string;
  init: RequestInit;
}

// A fetch that records each call and answers it with `answer`.
function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return answer(call);
  };
  return { calls, fetch };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

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
