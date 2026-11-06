import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPaymentClient,
  PAYMENT_RETRIES,
  PAYMENT_TIMEOUT_MS,
  PaymentProviderError,
  paymentKey,
} from '../src/checkout/payment-client.js';
import type { PaymentClientOptions } from '../src/checkout/payment-client.js';
import { createLogger } from '../src/logger.js';
import {
  countCharges,
  createTestSchema,
  faultsOf,
  startMock,
} from '../../payments-mock/test/helpers/mock.js';
import type { RunningMock } from '../../payments-mock/test/helpers/mock.js';

// The real payment mock from WP 5.1, in a schema of this file's own.
const SCHEMA = 'api_payment_client';
// Nothing listens on this port, so every connection is refused at once.
const UNREACHABLE_URL = 'http://127.0.0.1:1';

interface LogLine {
  level: number;
  msg: string;
  reason?: string;
  attempts?: number;
}
const LEVEL = { warn: 40, error: 50 };

function captureLogs(): { lines: LogLine[]; logger: ReturnType<typeof createLogger> } {
  const lines: LogLine[] = [];
  const logger = createLogger('debug', {
    write: (line: string) => lines.push(JSON.parse(line) as LogLine),
  });
  return { lines, logger };
}

// Records each wait instead of sleeping, so retries run at once and their delays can be checked.
function recordWaits(): { waits: number[]; wait: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

function charge(orderId = randomUUID(), amountPaise = 450_000) {
  return { key: paymentKey(orderId, randomUUID()), orderId, amountPaise };
}

interface StubRequest {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Stub {
  url: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

// A provider that answers however the test scripts it; attempt counts from 1.
async function startStub(answer: (res: ServerResponse, attempt: number) => void): Promise<Stub> {
  const requests: StubRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body });
      answer(res, requests.length);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function answerJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function chargeBody(key: string, status = 'succeeded') {
  return {
    id: randomUUID(),
    key,
    orderId: randomUUID(),
    amountPaise: 450_000,
    status,
    createdAt: new Date().toISOString(),
    refundedAt: null,
  };
}

describe('paymentKey', () => {
  it('builds pay:{orderId}:{clientKey} (FR-PAY-7)', () => {
    expect(paymentKey('11111111-2222-4333-8444-555555555555', 'tab-1')).toBe(
      'pay:11111111-2222-4333-8444-555555555555:tab-1',
    );
  });
});

describe('against the payment mock', () => {
  let pool: Pool;
  const mocks: RunningMock[] = [];

  async function mockWith(settings: Parameters<typeof faultsOf>[0]): Promise<string> {
    const mock = await startMock(pool, faultsOf(settings));
    mocks.push(mock);
    return mock.url;
  }

  function client(options: Partial<PaymentClientOptions> & { baseUrl: string }) {
    return createPaymentClient({ logger: createLogger('silent'), ...recordWaits(), ...options });
  }

  beforeAll(async () => {
    pool = await createTestSchema(SCHEMA);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE charges');
  });

  afterAll(async () => {
    await Promise.all(mocks.map((mock) => mock.close()));
    await pool.end();
  });

  it('charges once and reports success', async () => {
    const { lines, logger } = captureLogs();
    const request = charge();

    const result = await client({ baseUrl: await mockWith({}), logger }).charge(request);

    expect(result).toEqual({
      status: 'succeeded',
      charge: expect.objectContaining({
        key: request.key,
        orderId: request.orderId,
        amountPaise: 450_000,
        status: 'succeeded',
      }) as unknown,
    });
    expect(await countCharges(pool)).toBe(1);
    expect(lines.filter((line) => line.level >= LEVEL.warn)).toEqual([]);
  });

  it('reports a decline at once, without retrying', async () => {
    const { lines, logger } = captureLogs();

    const result = await client({ baseUrl: await mockWith({ declineRate: 1 }), logger }).charge(
      charge(),
    );

    expect(result.status).toBe('declined');
    expect(await countCharges(pool, `status = 'declined'`)).toBe(1);
    expect(lines.filter((line) => line.level >= LEVEL.warn)).toEqual([]);
  });

  it('retries a lost first response with the same key and gets the one charge back', async () => {
    const { lines, logger } = captureLogs();
    const request = charge();

    const result = await client({
      baseUrl: await mockWith({ lostResponseRate: 1 }),
      logger,
    }).charge(request);

    expect(result).toMatchObject({ status: 'succeeded', charge: { key: request.key } });
    expect(await countCharges(pool)).toBe(1);
    const retries = lines.filter((line) => line.level === LEVEL.warn);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.reason).toMatch(/^network: /);
  });

  it('times out a slow provider, and a later attempt gets the charge the first one made', async () => {
    // The provider takes 300 ms to record a charge; the client gives up on each attempt after
    // 150 ms. Attempts 1 and 2 time out, then attempt 3 finds what attempt 1 recorded.
    const { lines, logger } = captureLogs();
    const request = charge();

    const result = await createPaymentClient({
      baseUrl: await mockWith({ latencyMinMs: 300, latencyMaxMs: 300 }),
      logger,
      timeoutMs: 150,
      random: () => 1,
    }).charge(request);

    expect(result).toMatchObject({ status: 'succeeded', charge: { key: request.key } });
    expect(await countCharges(pool)).toBe(1);
    expect(lines.filter((line) => line.reason === 'timeout').length).toBeGreaterThanOrEqual(2);
  });

  it('reports an unreachable provider as unavailable after 1 attempt and 3 retries', async () => {
    const { lines, logger } = captureLogs();
    const { waits, wait } = recordWaits();

    const result = await createPaymentClient({
      baseUrl: UNREACHABLE_URL,
      logger,
      wait,
      random: () => 0.5,
    }).charge(charge());

    expect(result).toEqual({ status: 'unavailable' });
    // Full jitter under a cap that doubles from 100 ms: half of 100, 200 and 400.
    expect(waits).toEqual([50, 100, 200]);
    expect(lines.filter((line) => line.level === LEVEL.warn)).toHaveLength(3);
    expect(lines.filter((line) => line.level === LEVEL.error)).toMatchObject([
      { msg: 'payment provider unavailable, giving up', attempts: 4 },
    ]);
  });

  it('throws without retrying when the provider refuses the request', async () => {
    const { lines, logger } = captureLogs();
    const payments = client({ baseUrl: await mockWith({}), logger });
    const request = charge();
    await payments.charge(request);

    const reused = payments.charge({ ...request, amountPaise: 1 });

    await expect(reused).rejects.toBeInstanceOf(PaymentProviderError);
    await expect(reused).rejects.toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(lines.filter((line) => line.level >= LEVEL.warn)).toEqual([]);
  });

  it('refunds a charge, and a repeat returns the same refund', async () => {
    const payments = client({ baseUrl: await mockWith({}) });
    const request = charge();
    await payments.charge(request);

    const first = await payments.refund(request.key);
    const second = await payments.refund(request.key);

    expect(first).toMatchObject({ status: 'refunded', charge: { key: request.key } });
    expect(second).toEqual(first);
    expect(await countCharges(pool, `status = 'refunded'`)).toBe(1);
  });

  it('throws when asked to refund a declined charge', async () => {
    const payments = client({ baseUrl: await mockWith({ declineRate: 1 }) });
    const request = charge();
    await payments.charge(request);

    await expect(payments.refund(request.key)).rejects.toMatchObject({
      status: 409,
      code: 'CHARGE_DECLINED',
    });
  });

  it('reports a key whose charge was already refunded, so checkout can finish as refunded', async () => {
    const payments = client({ baseUrl: await mockWith({}) });
    const request = charge();
    await payments.charge(request);
    await payments.refund(request.key);

    const again = await payments.charge(request);

    expect(again).toMatchObject({ status: 'refunded', charge: { key: request.key } });
    expect(await countCharges(pool)).toBe(1);
  });

  it('reports a refund to an unreachable provider as unavailable', async () => {
    const { waits, wait } = recordWaits();

    const result = await client({ baseUrl: UNREACHABLE_URL, wait }).refund('pay:any');

    expect(result).toEqual({ status: 'unavailable' });
    expect(waits).toHaveLength(PAYMENT_RETRIES);
  });
});

describe('against a scripted provider', { timeout: 15_000 }, () => {
  const stubs: Stub[] = [];

  async function stub(answer: (res: ServerResponse, attempt: number) => void): Promise<Stub> {
    const started = await startStub(answer);
    stubs.push(started);
    return started;
  }

  afterAll(async () => {
    await Promise.all(stubs.map((started) => started.close()));
  });

  it('retries a 5xx with the same key, body and request ID', async () => {
    const callLogs = captureLogs();
    const clientLogs = captureLogs();
    const request = charge();
    const provider = await stub((res, attempt) => {
      if (attempt === 1) answerJson(res, 503, { error: 'busy' });
      else if (attempt === 2) answerJson(res, 500, { error: 'oops' });
      else answerJson(res, 201, { ...chargeBody(request.key), orderId: request.orderId });
    });

    const result = await createPaymentClient({
      baseUrl: provider.url,
      logger: clientLogs.logger,
      ...recordWaits(),
    }).charge(request, { logger: callLogs.logger, requestId: 'req-7' });

    expect(result.status).toBe('succeeded');
    expect(provider.requests).toHaveLength(3);
    for (const sent of provider.requests) {
      expect(sent.url).toBe('/charges');
      expect(sent.headers['idempotency-key']).toBe(request.key);
      expect(sent.headers['x-request-id']).toBe('req-7');
      expect(sent.headers['content-type']).toBe('application/json');
      expect(JSON.parse(sent.body)).toEqual({
        orderId: request.orderId,
        amountPaise: request.amountPaise,
      });
    }
    // The route's own logger hears about the retries, so they carry its request ID.
    expect(callLogs.lines.map((line) => line.reason)).toEqual(['status 503', 'status 500']);
    expect(clientLogs.lines).toEqual([]);
  });

  it('cuts off each attempt that gets no answer, then gives up', async () => {
    const provider = await stub(() => {
      // Never answers.
    });
    const started = performance.now();

    const result = await createPaymentClient({
      baseUrl: provider.url,
      logger: createLogger('silent'),
      timeoutMs: 100,
      ...recordWaits(),
    }).charge(charge());

    expect(result).toEqual({ status: 'unavailable' });
    expect(provider.requests).toHaveLength(1 + PAYMENT_RETRIES);
    expect(performance.now() - started).toBeGreaterThanOrEqual(4 * 95);
  });

  it('cuts off a provider that stalls halfway through its answer', async () => {
    const { lines, logger } = captureLogs();
    const request = charge();
    const provider = await stub((res, attempt) => {
      if (attempt === 1) {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.write('{"id":');
        return;
      }
      answerJson(res, 200, chargeBody(request.key));
    });

    const result = await createPaymentClient({
      baseUrl: provider.url,
      logger,
      timeoutMs: 100,
      ...recordWaits(),
    }).charge(request);

    expect(result.status).toBe('succeeded');
    expect(lines.map((line) => line.reason)).toEqual(['timeout']);
  });

  it.each([
    ['a body that is not a charge', { ok: true }],
    ['a body that is not JSON', 'nope'],
  ])('throws without retrying on %s', async (_name, body) => {
    const provider = await stub((res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });

    await expect(
      createPaymentClient({ baseUrl: provider.url, logger: createLogger('silent') }).charge(
        charge(),
      ),
    ).rejects.toBeInstanceOf(PaymentProviderError);
    expect(provider.requests).toHaveLength(1);
  });

  it('gives each attempt 3 seconds by default (FR-PAY-7)', async () => {
    const provider = await stub(() => {
      // Never answers.
    });
    const started = performance.now();

    const result = await createPaymentClient({
      baseUrl: provider.url,
      logger: createLogger('silent'),
      retries: 0,
    }).charge(charge());

    const elapsedMs = performance.now() - started;
    expect(result).toEqual({ status: 'unavailable' });
    expect(PAYMENT_TIMEOUT_MS).toBe(3_000);
    expect(elapsedMs).toBeGreaterThanOrEqual(2_950);
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
