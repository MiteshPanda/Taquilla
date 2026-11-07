import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client.js';
import { IN_PROGRESS_TRIES, IN_PROGRESS_WAIT_MS, payHold } from '../src/checkout/pay.js';
import { fakeFetch, json } from './helpers.js';

const HOLD_ID = '6f1c1e0e-6b1a-4a51-9a3e-2f0c1a7d9e11';
const ORDER = {
  orderId: '0b7c6c1a-2f4e-4d7b-8a62-3c9e5d1f7a20',
  holdId: HOLD_ID,
  status: 'paid',
  amountPaise: 250_000,
  createdAt: '2026-11-07T12:00:00.000Z',
  tickets: [{ id: 1, seatId: 5, section: 'Fondo Norte', row: 'A', number: 5, pricePaise: 250_000 }],
};
const IN_PROGRESS = {
  error: { code: 'REQUEST_IN_PROGRESS', message: 'This request is still being processed.' },
};

function client(answers: (() => Response)[]) {
  let n = 0;
  const { calls, fetch } = fakeFetch(() =>
    (answers[Math.min(n++, answers.length - 1)] ?? answers[0])!(),
  );
  return { calls, api: createApiClient({ baseUrl: 'http://api.test', fetch }) };
}

const keysOf = (calls: { init: RequestInit }[]) =>
  calls.map((call) => new Headers(call.init.headers).get('idempotency-key'));

describe('payHold', () => {
  it('pays once and returns the paid order', async () => {
    const wait = vi.fn(() => Promise.resolve());
    const { calls, api } = client([() => json(200, ORDER)]);

    await expect(payHold(api, HOLD_ID, 'a.b.c', 'key-1', { wait })).resolves.toEqual(ORDER);
    expect(calls).toHaveLength(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('sends the same request with the same key, a second apart, while the first is running', async () => {
    const wait = vi.fn(() => Promise.resolve());
    const { calls, api } = client([
      () => json(409, IN_PROGRESS),
      () => json(409, IN_PROGRESS),
      () => json(200, ORDER),
    ]);

    await expect(payHold(api, HOLD_ID, 'a.b.c', 'key-1', { wait })).resolves.toEqual(ORDER);
    expect(keysOf(calls)).toEqual(['key-1', 'key-1', 'key-1']);
    expect(wait.mock.calls).toEqual([[IN_PROGRESS_WAIT_MS], [IN_PROGRESS_WAIT_MS]]);
    expect(IN_PROGRESS_WAIT_MS).toBe(1_000);
  });

  it(`gives up after ${IN_PROGRESS_TRIES} tries and hands back the last 409`, async () => {
    const wait = vi.fn(() => Promise.resolve());
    const { calls, api } = client([() => json(409, IN_PROGRESS)]);

    await expect(payHold(api, HOLD_ID, 'a.b.c', 'key-1', { wait })).rejects.toMatchObject({
      code: 'REQUEST_IN_PROGRESS',
    });
    expect(IN_PROGRESS_TRIES).toBe(30);
    expect(calls).toHaveLength(IN_PROGRESS_TRIES);
    expect(wait).toHaveBeenCalledTimes(IN_PROGRESS_TRIES - 1);
  });

  it.each([
    ['a decline', 402, 'PAYMENT_DECLINED'],
    ['an outage', 503, 'PAYMENT_UNAVAILABLE'],
    ['a lost hold', 409, 'HOLD_EXPIRED'],
    ['another tab paying', 409, 'PAYMENT_IN_PROGRESS'],
  ])('hands back %s at once, without trying again', async (_case, status, code) => {
    const wait = vi.fn(() => Promise.resolve());
    const { calls, api } = client([() => json(status, { error: { code, message: 'No.' } })]);

    await expect(payHold(api, HOLD_ID, 'a.b.c', 'key-1', { wait })).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('waits a real second between tries when given nothing', async () => {
    vi.useFakeTimers();
    try {
      const { calls, api } = client([() => json(409, IN_PROGRESS), () => json(200, ORDER)]);
      const paid = payHold(api, HOLD_ID, 'a.b.c', 'key-1');

      await vi.advanceTimersByTimeAsync(IN_PROGRESS_WAIT_MS - 1);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(paid).resolves.toEqual(ORDER);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
