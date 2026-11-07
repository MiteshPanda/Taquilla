// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client.js';
import { ALREADY_ENDED, Booking, EXPIRED, FULL, RELEASED } from '../src/holds/Booking.js';
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

function setup({
  token = TOKEN,
  hold = (call: Call) => json(201, holdFor((bodyOf(call) as { seatIds: number[] }).seatIds)),
  release = () => new Response(null, { status: 204 }),
  states = () => json(200, { held: [], sold: [] }),
}: {
  token?: string | null;
  hold?: Answer;
  release?: Answer;
  states?: Answer;
} = {}) {
  const { calls, fetch } = fakeFetch((call) => {
    const path = new URL(call.url).pathname;
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
