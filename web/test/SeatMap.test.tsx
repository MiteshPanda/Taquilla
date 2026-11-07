// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client.js';
import type { ApiClient, Seat, SeatMapData, SeatStates } from '../src/api/client.js';
import { SeatMap } from '../src/seats/SeatMap.js';
import { standsOf } from '../src/seats/seats.js';
import { POLL_MAX_MS, POLL_MIN_MS, useSeatMap } from '../src/seats/useSeatMap.js';
import { planOf } from '../src/stadium/venue.js';
import type { Call } from './helpers.js';
import { fakeFetch, json, stadium } from './helpers.js';

type Answer = (call: Call) => Response | Promise<Response>;

const NOTHING_TAKEN: SeatStates = { held: [], sold: [] };

// Two stands of two rows of three seats: ids 1 to 6 in Fondo Norte, 7 to 12 in Fondo Sur.
function smallStadium(): SeatMapData {
  return stadium({
    rows: 2,
    seatsPerRow: 3,
    stands: [
      ['Fondo Norte', 250_000],
      ['Fondo Sur', 250_000],
    ],
  });
}

// The map as the booking flow uses it: polled by useSeatMap, with seats that can be picked.
function Harness({
  api,
  mine,
  selected,
  onToggleSeat,
  random,
}: {
  api: ApiClient;
  mine: ReadonlySet<number> | undefined;
  selected: ReadonlySet<number> | undefined;
  onToggleSeat: (seat: Seat) => void;
  random: () => number;
}) {
  const { map } = useSeatMap(api, 1, random);
  return <SeatMap map={map} mine={mine} selected={selected} onToggleSeat={onToggleSeat} />;
}

function setup({
  map = () => json(200, smallStadium()),
  states = () => json(200, NOTHING_TAKEN),
  mine,
  selected,
  onToggleSeat = () => undefined,
  random = () => 0,
}: {
  map?: Answer;
  states?: Answer;
  mine?: ReadonlySet<number>;
  selected?: ReadonlySet<number>;
  onToggleSeat?: (seat: Seat) => void;
  random?: () => number;
} = {}) {
  const { calls, fetch } = fakeFetch((call) =>
    new URL(call.url).pathname.endsWith('/states') ? states(call) : map(call),
  );
  const api = createApiClient({ baseUrl: 'http://api.test', fetch });
  const view = render(
    <Harness
      api={api}
      mine={mine}
      selected={selected}
      onToggleSeat={onToggleSeat}
      random={random}
    />,
  );
  const count = (path: string) =>
    calls.filter((call) => new URL(call.url).pathname === path).length;
  return {
    view,
    mapCalls: () => count('/events/1/seats'),
    pollCalls: () => count('/events/1/seats/states'),
  };
}

// Moves the fake clock and lets every answer that was due arrive.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

const seat = (name: string) => screen.getByRole('button', { name });
const tab = (stand: string) => screen.getByRole('tab', { name: new RegExp(`^${stand}`) });
// One stand's seats are shown at a time; its tab shows another.
function showStand(stand: string) {
  fireEvent.click(tab(stand));
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the map', () => {
  it('shows each stand, by its tab, as a grid of seat buttons named like "Fondo Sur, row B, seat 3, available"', async () => {
    setup();
    expect(screen.getByRole('status').textContent).toBe('Loading the seat map…');

    await advance(0);

    expect(screen.getByRole('heading', { name: 'Chamartín FC vs Castellana United' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Fondo Norte ₹2,500 6 of 6 available',
      'Fondo Sur ₹2,500 6 of 6 available',
    ]);
    // The first stand shows until another's tab is chosen.
    expect(screen.getAllByRole('grid').map((grid) => grid.getAttribute('aria-label'))).toEqual([
      'Fondo Norte',
    ]);
    expect(tab('Fondo Norte').getAttribute('aria-selected')).toBe('true');

    showStand('Fondo Sur');

    const fondoSur = screen.getByRole('grid', { name: 'Fondo Sur' });
    expect(within(fondoSur).getAllByRole('row')).toHaveLength(2);
    expect(within(fondoSur).getAllByRole('button')).toHaveLength(6);
    expect(seat('Fondo Sur, row B, seat 3, available')).toBeTruthy();
    expect(tab('Fondo Sur').getAttribute('aria-selected')).toBe('true');
    expect(tab('Fondo Norte').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tabpanel', { name: /^Fondo Sur/ }).contains(fondoSur)).toBe(true);
  });

  it('tells the states apart in words and in style, not by colour alone', async () => {
    const map = smallStadium();
    map.seats = map.seats.map((s) =>
      s.id === 2 || s.id === 3 ? { ...s, state: 'held' } : s.id === 4 ? { ...s, state: 'sold' } : s,
    );
    setup({ map: () => json(200, map), mine: new Set([3]) });

    await advance(0);

    const cases = [
      ['Fondo Norte, row A, seat 1, available', 'seat-available', null],
      ['Fondo Norte, row A, seat 2, held by another fan', 'seat-held', 'true'],
      // A seat the fan already holds can't be picked again.
      ['Fondo Norte, row A, seat 3, held by you', 'seat-yours', 'true'],
      ['Fondo Norte, row B, seat 1, sold', 'seat-sold', 'true'],
    ] as const;
    for (const [name, className, disabled] of cases) {
      const button = seat(name);
      expect(button.classList.contains(className)).toBe(true);
      expect(button.getAttribute('aria-disabled')).toBe(disabled);
      // A hover shows the same words.
      expect(button.title).toBe(name);
    }
    expect(tab('Fondo Norte').textContent).toBe('Fondo Norte ₹2,500 3 of 6 available');
    const key = screen.getByRole('list', { name: 'Key' });
    expect(
      within(key)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Available', 'Selected', 'Held by another fan', 'Held by you', 'Sold']);
  });

  it("draws the seed's whole stadium: four stands of 500 seats", async () => {
    setup({ map: () => json(200, stadium()) });

    await advance(0);

    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getAllByRole('button')).toHaveLength(500);
    showStand('Fondo Sur');
    expect(seat('Fondo Sur, row F, seat 12, available')).toBeTruthy();
    // The plan draws every seat of the four stands, each as one block of its path.
    const blocks = [...document.querySelectorAll('.ground-plan .g-open')].reduce(
      (sum, path) => sum + (path.getAttribute('d')?.match(/M/g)?.length ?? 0),
      0,
    );
    expect(blocks).toBe(2_000);
  });
});

describe('polling (FR-WEB-4)', () => {
  it('polls only the seat states, every 2 to 3 seconds, and shows what changed', async () => {
    const { mapCalls, pollCalls } = setup({
      states: () => json(200, { held: [1], sold: [12] }),
    });
    await advance(0);

    await advance(POLL_MIN_MS - 1);
    expect(pollCalls()).toBe(0);
    await advance(1);
    expect(pollCalls()).toBe(1);

    expect(seat('Fondo Norte, row A, seat 1, held by another fan')).toBeTruthy();
    expect(tab('Fondo Sur').textContent).toBe('Fondo Sur ₹2,500 5 of 6 available');
    showStand('Fondo Sur');
    expect(seat('Fondo Sur, row B, seat 3, sold')).toBeTruthy();
    await advance(POLL_MIN_MS);
    expect(pollCalls()).toBe(2);
    expect(mapCalls()).toBe(1);
  });

  it('waits a random time inside the window, so fans spread their polls', async () => {
    const { pollCalls } = setup({ random: () => 0.75 });
    await advance(0);

    await advance(POLL_MIN_MS + 0.75 * (POLL_MAX_MS - POLL_MIN_MS) - 1);
    expect(pollCalls()).toBe(0);
    await advance(1);
    expect(pollCalls()).toBe(1);
    expect([POLL_MIN_MS, POLL_MAX_MS]).toEqual([2_000, 3_000]);
  });

  it('pauses while the tab is hidden, and catches up the moment it is shown', async () => {
    const { pollCalls } = setup();
    await advance(0);
    setHidden(true);

    await advance(30_000);
    expect(pollCalls()).toBe(0);

    setHidden(false);
    await advance(0);
    expect(pollCalls()).toBe(1);
    await advance(POLL_MIN_MS);
    expect(pollCalls()).toBe(2);
  });

  it('keeps polling on schedule when the tab is hidden and shown between two polls', async () => {
    const { pollCalls } = setup();
    await advance(0);

    setHidden(true);
    setHidden(false);
    await advance(POLL_MIN_MS);

    expect(pollCalls()).toBe(1);
  });

  it('waits for a tab opened in the background to be shown before loading anything', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    const { mapCalls } = setup();

    await advance(10_000);
    expect(mapCalls()).toBe(0);

    setHidden(false);
    await advance(0);
    expect(mapCalls()).toBe(1);
    expect(seat('Fondo Norte, row A, seat 1, available')).toBeTruthy();
  });

  it('keeps the last map when a poll fails, says so, and clears it once a poll works', async () => {
    let fail = true;
    setup({
      states: () =>
        fail
          ? json(503, {
              error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is unavailable.' },
            })
          : json(200, { held: [], sold: [5] }),
    });
    await advance(0);

    await advance(POLL_MIN_MS);
    expect(screen.getByRole('status').textContent).toBe(
      'The seat map may be out of date. The database is unavailable. Trying again…',
    );
    expect(seat('Fondo Norte, row B, seat 2, available')).toBeTruthy();

    fail = false;
    await advance(POLL_MIN_MS);
    expect(screen.queryByRole('status')).toBeNull();
    expect(seat('Fondo Norte, row B, seat 2, sold')).toBeTruthy();
  });

  it('keeps trying the first load until it works', async () => {
    let fail = true;
    const { mapCalls } = setup({
      map: () =>
        fail ? Promise.reject(new TypeError('Failed to fetch')) : json(200, smallStadium()),
    });
    await advance(0);

    expect(screen.getByRole('status').textContent).toBe(
      "Can't load the seat map. Can't reach Taquilla. Check your connection and try again. Trying again…",
    );

    fail = false;
    await advance(POLL_MIN_MS);
    expect(mapCalls()).toBe(2);
    expect(seat('Fondo Norte, row A, seat 1, available')).toBeTruthy();
  });

  it('stops polling and drops its listener once the map is gone', async () => {
    const removed = vi.spyOn(document, 'removeEventListener');
    const { view, pollCalls } = setup();
    await advance(0);

    view.unmount();
    await advance(30_000);

    expect(pollCalls()).toBe(0);
    expect(removed).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('cancels a poll still on its way when the map is gone', async () => {
    let signal: AbortSignal | null | undefined;
    const { view } = setup({
      states: (call) => {
        signal = call.init.signal;
        return new Promise(() => undefined);
      },
    });
    await advance(POLL_MIN_MS);

    view.unmount();

    expect(signal?.aborted).toBe(true);
  });
});

describe('the keyboard', () => {
  const tabbable = () =>
    screen
      .getAllByRole('button')
      .filter((button) => button.tabIndex === 0)
      .map((b) => b.getAttribute('aria-label'));

  it('puts one seat of the stand shown in the tab order, not every seat', async () => {
    setup();
    await advance(0);
    expect(tabbable()).toEqual(['Fondo Norte, row A, seat 1, available']);

    showStand('Fondo Sur');

    expect(tabbable()).toEqual(['Fondo Sur, row A, seat 1, available']);
  });

  it('moves between the stands’ tabs with the arrow keys, Home and End, round the ends', async () => {
    setup({ map: () => json(200, stadium({ rows: 1, seatsPerRow: 2 })) });
    await advance(0);
    act(() => tab('Fondo Norte').focus());

    const press = (key: string) => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key });
      return [
        document.activeElement?.textContent?.split(' ₹')[0],
        screen.getByRole('grid').getAttribute('aria-label'),
      ];
    };

    expect(press('ArrowRight')).toEqual(['Fondo Sur', 'Fondo Sur']);
    expect(press('End')).toEqual(['Lateral Oeste', 'Lateral Oeste']);
    expect(press('ArrowRight')).toEqual(['Fondo Norte', 'Fondo Norte']);
    expect(press('ArrowLeft')).toEqual(['Lateral Oeste', 'Lateral Oeste']);
    expect(press('Home')).toEqual(['Fondo Norte', 'Fondo Norte']);
    expect(press('a')).toEqual(['Fondo Norte', 'Fondo Norte']);
    // Only the chosen tab is in the tab order.
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it('moves between seats with the arrow keys, Home and End, and stops at the edges', async () => {
    setup();
    await advance(0);
    const first = seat('Fondo Norte, row A, seat 1, available');
    first.focus();

    const press = (key: string, ctrlKey = false) => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key, ctrlKey });
      return document.activeElement?.getAttribute('aria-label');
    };

    expect(press('ArrowRight')).toBe('Fondo Norte, row A, seat 2, available');
    expect(press('ArrowDown')).toBe('Fondo Norte, row B, seat 2, available');
    expect(press('ArrowDown')).toBe('Fondo Norte, row B, seat 2, available');
    expect(press('End')).toBe('Fondo Norte, row B, seat 3, available');
    expect(press('ArrowRight')).toBe('Fondo Norte, row B, seat 3, available');
    expect(press('Home')).toBe('Fondo Norte, row B, seat 1, available');
    expect(press('ArrowLeft')).toBe('Fondo Norte, row B, seat 1, available');
    expect(press('ArrowUp')).toBe('Fondo Norte, row A, seat 1, available');
    expect(press('ArrowUp')).toBe('Fondo Norte, row A, seat 1, available');
    expect(press('End', true)).toBe('Fondo Norte, row B, seat 3, available');
    expect(press('Home', true)).toBe('Fondo Norte, row A, seat 1, available');
    // Other keys, such as Tab, are left to the browser.
    expect(press('a')).toBe('Fondo Norte, row A, seat 1, available');
  });

  it('moves to the last seat of a shorter row rather than nowhere', async () => {
    // Row A has three seats and row B two, as a row cut short by a gangway would.
    const map = smallStadium();
    map.seats = map.seats.filter(
      (s) => !(s.section === 'Fondo Norte' && s.row === 'B' && s.number === 3),
    );
    setup({ map: () => json(200, map) });
    await advance(0);
    act(() => seat('Fondo Norte, row A, seat 3, available').focus());

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' });

    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Fondo Norte, row B, seat 2, available',
    );
  });

  it('makes the last seat focused the stand’s tab stop', async () => {
    setup();
    await advance(0);

    showStand('Fondo Sur');

    act(() => seat('Fondo Sur, row B, seat 2, available').focus());

    expect(tabbable()).toEqual(['Fondo Sur, row B, seat 2, available']);
  });

  it('reaches a sold seat, so a screen reader can say it is sold', async () => {
    const map = smallStadium();
    map.seats = map.seats.map((s) => (s.id === 2 ? { ...s, state: 'sold' } : s));
    setup({ map: () => json(200, map) });
    await advance(0);
    seat('Fondo Norte, row A, seat 1, available').focus();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowRight' });

    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Fondo Norte, row A, seat 2, sold',
    );
  });
});

describe('the plan of the ground and the view from a seat', () => {
  const view = () => document.querySelector('.seat-view figcaption strong')?.textContent ?? null;
  const tag = () => document.querySelector('.ground-plan .g-tag text')?.textContent ?? null;
  const lifted = () => document.querySelectorAll('.ground-plan .g-lift').length;
  const plan = () => document.querySelector('svg.ground-plan') as SVGSVGElement;

  // The plan in jsdom has no layout, so it's given one: a screen pixel is a metre, and screen y
  // runs south, as on the page.
  function lay() {
    Object.defineProperty(plan(), 'getScreenCTM', {
      configurable: true,
      value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    });
  }

  // Where a seat of the small stadium is on the plan, in those screen pixels.
  function onPlan(seatId: number) {
    const spot = planOf(standsOf(smallStadium().seats)).byId.get(seatId);
    if (spot === undefined) throw new Error(`Seat ${seatId} isn't on the plan`);
    return { clientX: spot.at.x, clientY: -spot.at.y };
  }

  it('draws the ground before the seats arrive, and says how to see a view once they have', async () => {
    setup();
    expect(plan().getAttribute('role')).toBe('img');
    expect(document.querySelector('.ground-hint')).toBeNull();

    await advance(0);

    expect(document.querySelector('.ground-hint')?.textContent).toBe(
      'Point at a seat, or pick one, to see its view.',
    );
    expect(view()).toBeNull();
  });

  it('shows the view from the seat under the keyboard focus or the pointer, and tags it on the plan', async () => {
    setup();
    await advance(0);

    act(() => seat('Fondo Norte, row B, seat 2, available').focus());
    expect(view()).toBe('View from B-2');
    expect(
      screen.getByRole('img', { name: 'The view from Fondo Norte, row B, seat 2' }),
    ).toBeTruthy();
    expect(document.querySelector('.seat-view figcaption span')?.textContent).toBe(
      'Fondo Norte. Behind the goal, row B of 2, 91 m from the centre spot.',
    );
    expect(tag()).toBe('B-2');

    act(() => seat('Fondo Norte, row B, seat 2, available').blur());
    expect(view()).toBeNull();
    expect(tag()).toBeNull();

    fireEvent.pointerOver(seat('Fondo Norte, row A, seat 3, available'));
    expect(view()).toBe('View from A-3');
    fireEvent.pointerLeave(screen.getByRole('grid'));
    expect(view()).toBeNull();
  });

  it('lifts the fan’s picked and held seats out of the plan, and shows the newest pick’s view', async () => {
    // Fondo Sur A-2 was picked first, then Fondo Norte A-3.
    setup({ selected: new Set([8, 3]), mine: new Set([5]) });
    await advance(0);

    expect(lifted()).toBe(3);
    expect(view()).toBe('View from A-3');
    expect(tag()).toBe('A-3');

    // Pointing at another seat shows its view for as long as the pointer stays.
    fireEvent.pointerOver(seat('Fondo Norte, row B, seat 3, available'));
    expect(view()).toBe('View from B-3');
    fireEvent.pointerLeave(screen.getByRole('grid'));
    expect(view()).toBe('View from A-3');
  });

  it('shows the first held seat’s view when nothing is picked', async () => {
    setup({ mine: new Set([9, 10]) });
    await advance(0);

    expect(lifted()).toBe(2);
    expect(view()).toBe('View from A-3');
  });

  it('follows the pointer across the plan, seat by seat, and lets go off the stands', async () => {
    setup();
    await advance(0);
    lay();

    fireEvent.pointerMove(plan(), onPlan(10));
    expect(view()).toBe('View from B-1');
    fireEvent.pointerMove(plan(), { clientX: 0, clientY: 0 });
    expect(view()).toBeNull();
    fireEvent.pointerMove(plan(), onPlan(3));
    fireEvent.pointerLeave(plan());
    expect(view()).toBeNull();
  });

  it('picks a free seat clicked on the plan with a mouse, and shows its stand', async () => {
    const onToggleSeat = vi.fn<(seat: Seat) => void>();
    const map = smallStadium();
    map.seats = map.seats.map((s) => (s.id === 8 ? { ...s, state: 'sold' } : s));
    setup({ map: () => json(200, map), onToggleSeat });
    await advance(0);
    lay();

    fireEvent.pointerDown(plan(), { pointerType: 'mouse', ...onPlan(9) });
    fireEvent.click(plan(), onPlan(9));

    expect(onToggleSeat.mock.calls.map(([s]) => s.id)).toEqual([9]);
    expect(tab('Fondo Sur').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('grid', { name: 'Fondo Sur' })).toBeTruthy();

    // A sold seat, the pitch and a fan's finger pick nothing.
    fireEvent.click(plan(), onPlan(8));
    fireEvent.click(plan(), { clientX: 0, clientY: 0 });
    fireEvent.pointerDown(plan(), { pointerType: 'touch', ...onPlan(1) });
    fireEvent.click(plan(), onPlan(1));
    expect(onToggleSeat).toHaveBeenCalledTimes(1);
    // The tap still shows the seat's stand and its view.
    expect(tab('Fondo Norte').getAttribute('aria-selected')).toBe('true');
    expect(view()).toBe('View from A-1');
  });
});
