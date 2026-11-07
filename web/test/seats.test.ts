import { describe, expect, it } from 'vitest';
import {
  formatPrice,
  sameStates,
  seatLabel,
  standsOf,
  statesFrom,
  statesOf,
  viewOf,
} from '../src/seats/seats.js';
import { stadium } from './helpers.js';

describe('standsOf', () => {
  it("groups the seed's 2,000 seats into four stands of 20 rows of 25, in the API's order", () => {
    const stands = standsOf(stadium().seats);

    expect(stands.map((stand) => stand.name)).toEqual([
      'Fondo Norte',
      'Fondo Sur',
      'Lateral Este',
      'Lateral Oeste',
    ]);
    for (const stand of stands) {
      expect(stand.rows.map((row) => row.label)).toEqual([...'ABCDEFGHIJKLMNOPQRST']);
      expect(stand.rows.every((row) => row.seats.length === 25)).toBe(true);
      expect(stand.rows[0]?.seats.map((seat) => seat.number)).toEqual(
        Array.from({ length: 25 }, (_, i) => i + 1),
      );
    }
    expect(stands.map((stand) => stand.prices)).toEqual([
      [250_000],
      [250_000],
      [450_000],
      [450_000],
    ]);
  });

  it('lists each price in a stand once, lowest first', () => {
    const { seats } = stadium({ rows: 2, seatsPerRow: 2, stands: [['Lateral Este', 450_000]] });
    const priced = seats.map((seat, i) => ({
      ...seat,
      pricePaise: [500_000, 450_000][i % 2] ?? 0,
    }));

    expect(standsOf(priced)[0]?.prices).toEqual([450_000, 500_000]);
  });
});

describe('seat states', () => {
  const seats = stadium({ rows: 1, seatsPerRow: 4, stands: [['Fondo Sur', 250_000]] }).seats;

  it("takes each seat's state from the full map", () => {
    const mixed = seats.map((seat, i) => ({
      ...seat,
      state: (['available', 'held', 'sold'] as const)[i % 3] ?? 'available',
    }));

    expect([...statesOf(mixed)]).toEqual([
      [1, 'available'],
      [2, 'held'],
      [3, 'sold'],
      [4, 'available'],
    ]);
  });

  it('shows a seat listed as both held and sold as sold, since a sale is final', () => {
    expect(statesFrom(seats, { held: [2], sold: [2] }).get(2)).toBe('sold');
  });

  it('marks the polled seats held or sold, the rest available, and ignores unknown ids', () => {
    expect([...statesFrom(seats, { held: [2, 99], sold: [4] })]).toEqual([
      [1, 'available'],
      [2, 'held'],
      [3, 'available'],
      [4, 'sold'],
    ]);
  });

  it('compares two sets of states seat by seat', () => {
    const before = statesFrom(seats, { held: [2], sold: [] });

    expect(sameStates(before, statesFrom(seats, { held: [2], sold: [] }))).toBe(true);
    expect(sameStates(before, statesFrom(seats, { held: [], sold: [2] }))).toBe(false);
    expect(sameStates(before, statesFrom(seats.slice(1), { held: [2], sold: [] }))).toBe(false);
    // Fewer seats, all matching, is still a different map.
    expect(sameStates(statesFrom(seats.slice(1), { held: [2], sold: [] }), before)).toBe(false);
  });

  it("shows a held seat as the fan's own only when it's in their hold", () => {
    expect(viewOf('held', true)).toBe('yours');
    expect(viewOf('held', false)).toBe('held');
    // A seat they held but lost, or have since bought, shows as it is.
    expect(viewOf('available', true)).toBe('available');
    expect(viewOf('sold', true)).toBe('sold');
  });
});

describe('seatLabel', () => {
  const seat = {
    id: 1,
    section: 'Fondo Sur',
    row: 'F',
    number: 12,
    pricePaise: 250_000,
    state: 'available' as const,
  };

  it.each([
    ['available', 'Fondo Sur, row F, seat 12, available'],
    ['held', 'Fondo Sur, row F, seat 12, held by another fan'],
    ['yours', 'Fondo Sur, row F, seat 12, held by you'],
    ['sold', 'Fondo Sur, row F, seat 12, sold'],
  ] as const)('names the seat and says it is %s', (view, label) => {
    expect(seatLabel(seat, view)).toBe(label);
  });
});

describe('formatPrice', () => {
  it.each([
    [450_000, '₹4,500'],
    [250_000, '₹2,500'],
    [10_000_000, '₹1,00,000'],
    [45_050, '₹450.50'],
    [5, '₹0.05'],
  ])('formats %i paise as %s, without floating point', (paise, text) => {
    expect(formatPrice(paise)).toBe(text);
  });
});
