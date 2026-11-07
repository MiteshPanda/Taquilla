// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client.js';
import { Booking } from '../src/holds/Booking.js';
import { IN_PROGRESS_TRIES, IN_PROGRESS_WAIT_MS } from '../src/checkout/pay.js';
import { RESERVE_MS } from '../src/holds/HoldPanel.js';
import {
  ALREADY_ENDED,
  DECLINED,
  EXPIRED,
  FULL,
  HOLD_GONE,
  HOLD_RAN_OUT,
  PAYING,
  RELEASED,
  SEATS_LOST_REFUNDED,
  STILL_GOING,
  UNAVAILABLE,
  UNCONFIRMED,
} from '../src/holds/messages.js';
import { POLL_MIN_MS } from '../src/seats/useSeatMap.js';
import type { Call } from './helpers.js';
import { bodyOf, fakeFetch, json, stadium } from './helpers.js';

type Answer = (call: Call) => Response | Promise<Response>;

const TOKEN = 'a.b.c';
const HOLD_ID = '6f1c1e0e-6b1a-4a51-9a3e-2f0c1a7d9e11';
// A second off the polls' 2-second rhythm, so the poll asked for when the hold runs out is the
// only one at that moment.
const HOLD_MS = 301_000;

// Two stands of two rows of three seats at ₹2,500: ids 1 to 6 in Fondo Norte (A-1 to B-3),
// 7 to 12 in Fondo Sur.
const MAP = stadium({
  rows: 2,
  seatsPerRow: 3,
  stands: [
    ['Fondo Norte', 250_000],
    ['Fondo Sur', 250_000],
  ],
});

function holdFor(seatIds: number[]) {
  return {
    holdId: HOLD_ID,
    seatIds,
    amountPaise: 250_000 * seatIds.length,
    expiresAt: new Date(Date.now() + HOLD_MS).toISOString(),
  };
}

const ORDER_ID = '0b7c6c1a-2f4e-4d7b-8a62-3c9e5d1f7a20';

// The order a paid checkout answers with, for the seats held.
function orderFor(seatIds: number[]) {
  return {
    orderId: ORDER_ID,
    holdId: HOLD_ID,
    status: 'paid',
    amountPaise: 250_000 * seatIds.length,
    createdAt: new Date(Date.now()).toISOString(),
    tickets: seatIds.map((seatId, i) => {
      const seat = MAP.seats.find((s) => s.id === seatId);
      return {
        id: i + 1,
        seatId,
        section: seat?.section,
        row: seat?.row,
        number: seat?.number,
        pricePaise: 250_000,
      };
    }),
  };
}

function setup({
  token = TOKEN,
  hold = (call: Call) => json(201, holdFor((bodyOf(call) as { seatIds: number[] }).seatIds)),
  release = () => new Response(null, { status: 204 }),
  states = () => json(200, { held: [], sold: [] }),
  checkout = () => json(200, orderFor([1, 2])),
}: {
  token?: string | null;
  hold?: Answer;
  release?: Answer;
  states?: Answer;
  checkout?: Answer;
} = {}) {
  const { calls, fetch } = fakeFetch((call) => {
    const path = new URL(call.url).pathname;
    if (call.init.method === 'POST' && path === `/holds/${HOLD_ID}/checkout`) {
      return checkout(call);
    }
    if (call.init.method === 'POST' && path === '/events/1/holds') return hold(call);
    if (call.init.method === 'DELETE' && path.startsWith('/holds/')) return release(call);
    if (path === '/events/1/seats/states') return states(call);
    if (path === '/events/1/seats') return json(200, MAP);
    throw new Error(`Unexpected request: ${call.init.method} ${path}`);
  });
  const api = createApiClient({ baseUrl: 'http://api.test', fetch });
  let keys = 0;
  const newKey = () => `key-${(keys += 1)}`;
  const props = { api, random: () => 0, newKey };
  const view = render(<Booking {...props} token={token} />);
  const callsTo = (method: string, path: string) =>
    calls.filter((call) => call.init.method === method && new URL(call.url).pathname === path);
  return {
    view,
    rerender: (next: string | null) => view.rerender(<Booking {...props} token={next} />),
    holdCalls: () => callsTo('POST', '/events/1/holds'),
    checkoutCalls: () => callsTo('POST', `/holds/${HOLD_ID}/checkout`),
    releaseCalls: () => calls.filter((call) => call.init.method === 'DELETE'),
    pollCalls: () => callsTo('GET', '/events/1/seats/states').length,
  };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function click(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
  await advance(0);
}

const bar = () => screen.getByRole('region', { name: 'Your seats' });
const seatButton = (name: string) => screen.getByRole('button', { name });
const headerOf = (call: Call | undefined, name: string) =>
  new Headers(call?.init.headers).get(name);

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 7, 12, 0, 0) });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('picking seats', () => {
  it('turns a free seat into a pressed toggle, shown as selected, and back', async () => {
    setup();
    await advance(0);
    expect(bar().textContent).toBe('Pick up to 6 seats on the map.');

    await click('Fondo Norte, row A, seat 1, available');

    const picked = seatButton('Fondo Norte, row A, seat 1, selected');
    expect(picked.getAttribute('aria-pressed')).toBe('true');
    expect(picked.classList.contains('seat-selected')).toBe(true);
    expect(bar().textContent).toContain('1 seat selected: A-1 in Fondo Norte · ₹2,500');
    expect(seatButton('Fondo Norte, row A, seat 2, available').getAttribute('aria-pressed')).toBe(
      'false',
    );

    await click('Fondo Norte, row A, seat 1, selected');
    expect(bar().textContent).toBe('Pick up to 6 seats on the map.');
  });

  it('refuses a seventh seat and says why, until one is unpicked', async () => {
    setup();
    await advance(0);
    for (const n of [1, 2, 3]) await click(`Fondo Norte, row A, seat ${n}, available`);
    for (const n of [1, 2, 3]) await click(`Fondo Norte, row B, seat ${n}, available`);

    await click('Fondo Sur, row A, seat 1, available');

    expect(screen.getByText(FULL).getAttribute('role')).toBe('status');
    expect(seatButton('Fondo Sur, row A, seat 1, available')).toBeTruthy();
    expect(bar().textContent).toContain(
      '6 seats selected: A-1, A-2, A-3, B-1, B-2 and B-3 in Fondo Norte · ₹15,000',
    );

    await click('Fondo Norte, row B, seat 3, selected');
    expect(screen.queryByText(FULL)).toBeNull();
  });

  it('drops a picked seat someone else takes, and no longer counts it', async () => {
    let held: number[] = [];
    setup({ states: () => json(200, { held, sold: [] }) });
    await advance(0);
    for (const n of [1, 2, 3]) await click(`Fondo Norte, row A, seat ${n}, available`);
    for (const n of [1, 2, 3]) await click(`Fondo Norte, row B, seat ${n}, available`);

    held = [1];
    await advance(POLL_MIN_MS);
    expect(bar().textContent).toContain('5 seats selected');

    await click('Fondo Sur, row A, seat 1, available');
    expect(screen.queryByText(FULL)).toBeNull();
    expect(bar().textContent).toContain('6 seats selected');
  });

  it('asks a fan who is not logged in to log in before holding', async () => {
    setup({ token: null });
    await advance(0);

    await click('Fondo Norte, row A, seat 1, available');

    expect(bar().textContent).toContain('Log in to hold them.');
    expect(screen.queryByRole('button', { name: /^Hold/ })).toBeNull();
  });

  it('clears the picks', async () => {
    setup();
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');

    await click('Clear');

    expect(seatButton('Fondo Norte, row A, seat 1, available')).toBeTruthy();
  });
});

describe('holding seats', () => {
  it('holds the picks with a key and the token, then shows them as the fan’s own', async () => {
    let held: number[] = [];
    const { holdCalls, pollCalls } = setup({ states: () => json(200, { held, sold: [] }) });
    await advance(0);
    await click('Fondo Norte, row A, seat 2, available');
    await click('Fondo Norte, row A, seat 1, available');
    held = [1, 2];
    const pollsBefore = pollCalls();

    await click('Hold 2 seats');

    expect(bodyOf(holdCalls()[0])).toEqual({ seatIds: [2, 1] });
    expect(headerOf(holdCalls()[0], 'Idempotency-Key')).toBe('key-1');
    expect(headerOf(holdCalls()[0], 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(bar().textContent).toContain("You're holding A-2 and A-1 in Fondo Norte · ₹5,000");
    expect(screen.getByRole('timer').textContent).toBe('5:01');
    // The map is asked at once, rather than at the next poll, and shows the seats as the fan's.
    expect(pollCalls()).toBe(pollsBefore + 1);
    expect(seatButton('Fondo Norte, row A, seat 1, held by you')).toBeTruthy();
    // One hold at a time: nothing else can be picked while it runs.
    expect(seatButton('Fondo Norte, row A, seat 3, available').getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('counts down to expiresAt, warns at a minute, and frees the seats when time is up', async () => {
    const { pollCalls } = setup();
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');
    await click('Hold 1 seat');

    await advance(1_000);
    expect(screen.getByRole('timer').textContent).toBe('5:00');
    expect(screen.queryByText('One minute left on your hold.')).toBeNull();

    await advance(HOLD_MS - 61_000);
    expect(screen.getByRole('timer').textContent).toBe('1:00');
    expect(screen.getByText('One minute left on your hold.')).toBeTruthy();

    await advance(59_000);
    expect(screen.getByRole('timer').textContent).toBe('0:01');

    const pollsBefore = pollCalls();
    await advance(1_000);
    expect(screen.getByRole('status').textContent).toBe(EXPIRED);
    expect(screen.queryByRole('timer')).toBeNull();
    expect(pollCalls()).toBe(pollsBefore + 1);
  });

  it('asks the map again once a poll that was already out comes back', async () => {
    const slow = Promise.withResolvers<Response>();
    let polls = 0;
    const { pollCalls } = setup({
      states: () => (++polls === 1 ? slow.promise : json(200, { held: [1], sold: [] })),
    });
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');
    await advance(POLL_MIN_MS);
    expect(pollCalls()).toBe(1);

    // The hold lands while that poll is still out, so its answer may predate the hold.
    await click('Hold 1 seat');
    expect(pollCalls()).toBe(1);

    slow.resolve(json(200, { held: [], sold: [] }));
    await advance(0);
    expect(pollCalls()).toBe(2);
    expect(seatButton('Fondo Norte, row A, seat 1, held by you')).toBeTruthy();
  });

  it('makes a new key for a new hold of the same seats after the last one ended', async () => {
    const { holdCalls } = setup();
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');
    await click('Hold 1 seat');
    await click('Release');

    await click('Fondo Norte, row A, seat 1, available');
    await click('Hold 1 seat');

    // The first key's answer is the released hold, which the API would replay.
    expect(holdCalls().map((call) => headerOf(call, 'Idempotency-Key'))).toEqual([
      'key-1',
      'key-2',
    ]);
  });

  it('locks the buttons while the hold is on its way', async () => {
    const answer = Promise.withResolvers<Response>();
    setup({ hold: () => answer.promise });
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');

    await click('Hold 1 seat');

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Holding…' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Clear' }).disabled).toBe(true);
    answer.resolve(json(201, holdFor([1])));
    await advance(0);
    expect(screen.getByRole('timer')).toBeTruthy();
  });

  it('hides the hold once the fan logs out', async () => {
    const { rerender } = setup();
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');
    await click('Hold 1 seat');

    rerender(null);

    expect(screen.queryByRole('timer')).toBeNull();
    expect(bar().textContent).toBe('Pick up to 6 seats on the map.');
  });
});

describe('a seat someone just took (FR-WEB-5)', () => {
  const taken = (seatIds: number[]) => () =>
    json(409, {
      error: { code: 'SEAT_TAKEN', message: `Seat ${seatIds[0]} was just taken.`, seatIds },
    });

  it('names the seat, drops it from the picks and refreshes the map at once', async () => {
    const { pollCalls } = setup({ hold: taken([2]) });
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');
    await click('Fondo Norte, row A, seat 2, available');
    const pollsBefore = pollCalls();

    await click('Hold 2 seats');

    expect(screen.getByRole('alert').textContent).toBe(
      'Someone just took A-2 in Fondo Norte. Pick another seat.',
    );
    expect(bar().textContent).toContain('1 seat selected: A-1 in Fondo Norte');
    expect(pollCalls()).toBe(pollsBefore + 1);
  });

  it('names every seat taken, stand by stand', async () => {
    setup({ hold: taken([2, 8]) });
    await advance(0);
    await click('Fondo Norte, row A, seat 2, available');
    await click('Fondo Sur, row A, seat 2, available');

    await click('Hold 2 seats');

    expect(screen.getByRole('alert').textContent).toBe(
      'Someone just took A-2 in Fondo Norte and A-2 in Fondo Sur. Pick other seats.',
    );
  });

  it('falls back to the API’s words for seats the map does not know', async () => {
    setup({ hold: taken([99]) });
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');

    await click('Hold 1 seat');

    expect(screen.getByRole('alert').textContent).toBe('Seat 99 was just taken.');
  });

  it('makes a new key for the next try, since the seats asked for changed', async () => {
    let answer: Answer = taken([2]);
    const { holdCalls } = setup({ hold: (call) => answer(call) });
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');
    await click('Fondo Norte, row A, seat 2, available');
    await click('Hold 2 seats');

    answer = (call) => json(201, holdFor((bodyOf(call) as { seatIds: number[] }).seatIds));
    await click('Hold 1 seat');

    expect(holdCalls().map((call) => headerOf(call, 'Idempotency-Key'))).toEqual([
      'key-1',
      'key-2',
    ]);
  });
});

describe('other failures', () => {
  it('shows a busy answer in the API’s words, keeps the picks, and retries with the same key', async () => {
    let busy = true;
    const { holdCalls } = setup({
      hold: (call) =>
        busy
          ? json(409, { error: { code: 'SEAT_BUSY', message: 'Those seats are busy right now.' } })
          : json(201, holdFor((bodyOf(call) as { seatIds: number[] }).seatIds)),
    });
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');

    await click('Hold 1 seat');
    expect(screen.getByRole('alert').textContent).toBe('Those seats are busy right now.');
    expect(bar().textContent).toContain('1 seat selected');

    busy = false;
    await click('Hold 1 seat');
    expect(holdCalls().map((call) => headerOf(call, 'Idempotency-Key'))).toEqual([
      'key-1',
      'key-1',
    ]);
    expect(screen.getByRole('timer')).toBeTruthy();
  });

  it('retries a hold whose answer was lost with the same key, so it gets that hold back', async () => {
    let lost = true;
    const { holdCalls } = setup({
      hold: (call) =>
        lost
          ? Promise.reject(new TypeError('Failed to fetch'))
          : json(201, holdFor((bodyOf(call) as { seatIds: number[] }).seatIds)),
    });
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');

    await click('Hold 1 seat');
    expect(screen.getByRole('alert').textContent).toBe(
      "Can't reach Taquilla. Check your connection and try again.",
    );

    lost = false;
    await click('Hold 1 seat');
    expect(holdCalls().map((call) => headerOf(call, 'Idempotency-Key'))).toEqual([
      'key-1',
      'key-1',
    ]);
  });

  it('starts a fresh key when the fan changes the seats after a failure', async () => {
    const { holdCalls } = setup({ hold: () => Promise.reject(new TypeError('Failed to fetch')) });
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');
    await click('Hold 1 seat');

    await click('Fondo Norte, row A, seat 2, available');
    await click('Hold 2 seats');

    expect(holdCalls().map((call) => headerOf(call, 'Idempotency-Key'))).toEqual([
      'key-1',
      'key-2',
    ]);
  });

  it('drops the key after a refusal that would only repeat itself', async () => {
    const { holdCalls } = setup({
      hold: () =>
        json(400, { error: { code: 'VALIDATION_FAILED', message: 'List each seat only once.' } }),
    });
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');

    await click('Hold 1 seat');
    await click('Hold 1 seat');

    expect(screen.getByRole('alert').textContent).toBe('List each seat only once.');
    expect(holdCalls().map((call) => headerOf(call, 'Idempotency-Key'))).toEqual([
      'key-1',
      'key-2',
    ]);
  });
});

describe('releasing', () => {
  async function holding(options: Parameters<typeof setup>[0] = {}) {
    const harness = setup(options);
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');
    await click('Hold 1 seat');
    return harness;
  }

  it('releases the hold with the token, says so and refreshes the map', async () => {
    const { releaseCalls, pollCalls } = await holding();
    const pollsBefore = pollCalls();

    await click('Release');

    expect(releaseCalls().map((call) => new URL(call.url).pathname)).toEqual([`/holds/${HOLD_ID}`]);
    expect(headerOf(releaseCalls()[0], 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(screen.getByRole('status').textContent).toBe(RELEASED);
    expect(screen.queryByRole('timer')).toBeNull();
    expect(pollCalls()).toBe(pollsBefore + 1);
  });

  it('treats a hold that has already gone as released', async () => {
    await holding({
      release: () =>
        json(404, { error: { code: 'NOT_FOUND', message: 'This hold does not exist.' } }),
    });

    await click('Release');

    expect(screen.getByRole('status').textContent).toBe(ALREADY_ENDED);
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('keeps the hold and says why when the release fails', async () => {
    await holding({ release: () => Promise.reject(new TypeError('Failed to fetch')) });

    await click('Release');

    expect(screen.getByRole('alert').textContent).toBe(
      "Can't reach Taquilla. Check your connection and try again.",
    );
    expect(screen.getByRole('timer')).toBeTruthy();
  });
});

describe('paying (FR-WEB-3)', () => {
  const error =
    (status: number, code: string, message = 'The API says no.') =>
    () =>
      json(status, { error: { code, message } });

  // Holds A-1 and A-2 (key-1), then opens the payment step, which makes the payment key, key-2.
  async function atPayment(options: Parameters<typeof setup>[0] = {}) {
    const harness = setup(options);
    await advance(0);
    await click('Fondo Norte, row A, seat 1, available');
    await click('Fondo Norte, row A, seat 2, available');
    await click('Hold 2 seats');
    await click('Check out');
    return harness;
  }

  const payKeys = (calls: Call[]) => calls.map((call) => headerOf(call, 'Idempotency-Key'));
  const PAID = 'Paid ₹5,000. Your tickets:';

  it('pays with the key made when the step opened, then shows the tickets', async () => {
    const { checkoutCalls, pollCalls } = await atPayment();
    expect(screen.getByText('This is a test payment: no real money moves.')).toBeTruthy();
    const pollsBefore = pollCalls();

    await click('Pay ₹5,000');

    expect(payKeys(checkoutCalls())).toEqual(['key-2']);
    expect(headerOf(checkoutCalls()[0], 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(checkoutCalls()[0]?.init.body).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(PAID);
    const tickets = [...document.querySelectorAll('.tickets li')].map((item) => item.textContent);
    expect(tickets).toEqual([
      'Fondo Norte, row A, seat 1 · ₹2,500',
      'Fondo Norte, row A, seat 2 · ₹2,500',
    ]);
    expect(bar().textContent).toContain(`Order ${ORDER_ID}`);
    expect(pollCalls()).toBe(pollsBefore + 1);

    await click('Pick more seats');
    expect(bar().textContent).toBe('Pick up to 6 seats on the map.');
  });

  it('sends one request for a double-clicked Pay', async () => {
    const answer = Promise.withResolvers<Response>();
    const { checkoutCalls } = await atPayment({ checkout: () => answer.promise });
    const pay = screen.getByRole('button', { name: 'Pay ₹5,000' });

    // Both clicks land before the page redraws and disables the button.
    act(() => {
      pay.click();
      pay.click();
    });
    await advance(0);

    expect(checkoutCalls()).toHaveLength(1);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Paying…' }).disabled).toBe(true);
    expect(screen.getByText(PAYING)).toBeTruthy();
    // The countdown steps aside while paying, and the hold can't be released mid-payment.
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
    answer.resolve(json(200, orderFor([1, 2])));
    await advance(0);
    expect(screen.getByText(PAID)).toBeTruthy();
  });

  it('rides out 409 REQUEST_IN_PROGRESS with the same key until the first answer comes back', async () => {
    let n = 0;
    const { checkoutCalls } = await atPayment({
      checkout: () => (++n < 3 ? error(409, 'REQUEST_IN_PROGRESS')() : json(200, orderFor([1, 2]))),
    });

    await click('Pay ₹5,000');
    expect(checkoutCalls()).toHaveLength(1);
    expect(screen.getByText(PAYING)).toBeTruthy();
    await advance(IN_PROGRESS_WAIT_MS);
    await advance(IN_PROGRESS_WAIT_MS);

    expect(payKeys(checkoutCalls())).toEqual(['key-2', 'key-2', 'key-2']);
    expect(screen.getByText(PAID)).toBeTruthy();
  });

  it('says the payment is still going through if the first never answers, then tries the same key', async () => {
    const { checkoutCalls } = await atPayment({ checkout: error(409, 'REQUEST_IN_PROGRESS') });

    await click('Pay ₹5,000');
    await advance(IN_PROGRESS_WAIT_MS * IN_PROGRESS_TRIES);
    expect(screen.getByRole('status').textContent).toBe(STILL_GOING);

    await click('Pay ₹5,000');
    expect(new Set(payKeys(checkoutCalls()))).toEqual(new Set(['key-2']));
  });

  it('keeps the key for a retry after the provider was unavailable (503)', async () => {
    let n = 0;
    const { checkoutCalls } = await atPayment({
      checkout: () =>
        ++n === 1 ? error(503, 'PAYMENT_UNAVAILABLE')() : json(200, orderFor([1, 2])),
    });

    await click('Pay ₹5,000');
    expect(screen.getByRole('alert').textContent).toBe(UNAVAILABLE);

    await click('Pay ₹5,000');
    expect(payKeys(checkoutCalls())).toEqual(['key-2', 'key-2']);
    expect(screen.getByText(PAID)).toBeTruthy();
  });

  it('keeps the key for a retry after an answer that never came', async () => {
    let n = 0;
    const { checkoutCalls } = await atPayment({
      checkout: () =>
        ++n === 1 ? Promise.reject(new TypeError('Failed to fetch')) : json(200, orderFor([1, 2])),
    });

    await click('Pay ₹5,000');
    expect(screen.getByRole('alert').textContent).toBe(UNCONFIRMED);

    await click('Pay ₹5,000');
    expect(payKeys(checkoutCalls())).toEqual(['key-2', 'key-2']);
  });

  it('makes a new key only after a decline', async () => {
    let n = 0;
    const { checkoutCalls } = await atPayment({
      checkout: () => (++n === 1 ? error(402, 'PAYMENT_DECLINED')() : json(200, orderFor([1, 2]))),
    });

    await click('Pay ₹5,000');
    expect(screen.getByRole('alert').textContent).toBe(DECLINED);

    await click('Pay ₹5,000');
    expect(payKeys(checkoutCalls())).toEqual(['key-2', 'key-3']);
    expect(screen.getByText(PAID)).toBeTruthy();
  });

  it.each([
    ['a decline', 402, 'PAYMENT_DECLINED'],
    ['an outage', 503, 'PAYMENT_UNAVAILABLE'],
  ])('keeps the seats on the countdown for 10 minutes after %s', async (_case, status, code) => {
    await atPayment({ checkout: error(status, code) });
    expect(screen.getByRole('timer').textContent).toBe('5:01');

    await click('Pay ₹5,000');
    await advance(500);

    expect(screen.getByRole('timer').textContent).toBe('10:00');
  });

  it('keeps the seats on the countdown for 10 minutes once a payment reached the API', async () => {
    await atPayment({ checkout: error(402, 'PAYMENT_DECLINED') });
    expect(screen.getByRole('timer').textContent).toBe('5:01');

    await click('Pay ₹5,000');
    await advance(500);

    expect(RESERVE_MS).toBe(600_000);
    expect(screen.getByRole('timer').textContent).toBe('10:00');
    // Long after the hold's first 5 minutes, it's still there.
    await advance(HOLD_MS + 1_000);
    expect(screen.queryByText(EXPIRED)).toBeNull();
    expect(screen.getByRole('timer')).toBeTruthy();
  });

  it('keeps the key when the fan goes back and opens the payment step again', async () => {
    let n = 0;
    const { checkoutCalls } = await atPayment({
      checkout: () =>
        ++n === 1 ? error(503, 'PAYMENT_UNAVAILABLE')() : json(200, orderFor([1, 2])),
    });
    await click('Pay ₹5,000');

    await click('Back');
    await click('Check out');
    await click('Pay ₹5,000');

    expect(payKeys(checkoutCalls())).toEqual(['key-2', 'key-2']);
  });

  it.each([
    ['HOLD_EXPIRED', 409, HOLD_RAN_OUT],
    ['SEAT_LOST_REFUNDED', 409, SEATS_LOST_REFUNDED],
    ['NOT_FOUND', 404, HOLD_GONE],
  ])('ends the hold on %s, says why and refreshes the map', async (code, status, text) => {
    const { pollCalls } = await atPayment({ checkout: error(status, code) });
    const pollsBefore = pollCalls();

    await click('Pay ₹5,000');

    expect(screen.getByRole('alert').textContent).toBe(text);
    expect(screen.queryByRole('timer')).toBeNull();
    expect(bar().textContent).toContain('Pick up to 6 seats on the map.');
    expect(pollCalls()).toBe(pollsBefore + 1);
  });

  it('shows another tab paying in the API words and keeps the key', async () => {
    const message =
      'This order is already being paid in another tab or window. Wait for it to finish.';
    const { checkoutCalls } = await atPayment({
      checkout: error(409, 'PAYMENT_IN_PROGRESS', message),
    });

    await click('Pay ₹5,000');
    await click('Pay ₹5,000');

    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(payKeys(checkoutCalls())).toEqual(['key-2', 'key-2']);
  });

  it('makes a new key if the API says this key was used for something else', async () => {
    const { checkoutCalls } = await atPayment({
      checkout: error(422, 'IDEMPOTENCY_KEY_REUSED', 'This key was used for a different request.'),
    });

    await click('Pay ₹5,000');
    await click('Pay ₹5,000');

    expect(payKeys(checkoutCalls())).toEqual(['key-2', 'key-3']);
  });
});
