import { describe, expect, it } from 'vitest';
import { formatLeft } from '../src/holds/Countdown.js';
import { EMPTY_SELECTION, selectionReducer } from '../src/holds/selection.js';
import type { Selection } from '../src/holds/selection.js';
import {
  describeSeats,
  MAX_HOLD_SEATS,
  seatName,
  takenMessage,
  viewOf,
} from '../src/seats/seats.js';
import { stadium } from './helpers.js';

const allFree = () => true;

function pick(state: Selection, seatId: number, isFree: (id: number) => boolean = allFree) {
  return selectionReducer(state, { type: 'toggle', seatId, isFree });
}

describe('selectionReducer', () => {
  it('adds a seat, in the order picked, and takes it away again', () => {
    const two = pick(pick(EMPTY_SELECTION, 7), 3);
    expect(two).toEqual({ seatIds: [7, 3], full: false });

    expect(pick(two, 7)).toEqual({ seatIds: [3], full: false });
  });

  it(`stops at ${MAX_HOLD_SEATS} seats and marks the refused pick, until one is taken away`, () => {
    let state = EMPTY_SELECTION;
    for (const id of [1, 2, 3, 4, 5, 6]) state = pick(state, id);

    const refused = pick(state, 7);
    expect(MAX_HOLD_SEATS).toBe(6);
    expect(refused).toEqual({ seatIds: [1, 2, 3, 4, 5, 6], full: true });

    expect(pick(refused, 6)).toEqual({ seatIds: [1, 2, 3, 4, 5], full: false });
  });

  it("doesn't count picked seats someone else has taken since", () => {
    let state = EMPTY_SELECTION;
    for (const id of [1, 2, 3, 4, 5, 6]) state = pick(state, id);

    expect(pick(state, 7, (id) => id !== 2)).toEqual({ seatIds: [1, 3, 4, 5, 6, 7], full: false });
  });

  it('removes the seats a 409 named, and clears', () => {
    const state = { seatIds: [1, 2, 3], full: true };

    expect(selectionReducer(state, { type: 'remove', seatIds: [2, 9] })).toEqual({
      seatIds: [1, 3],
      full: false,
    });
    expect(selectionReducer(state, { type: 'clear' })).toBe(EMPTY_SELECTION);
  });
});

describe('seat names', () => {
  const { seats } = stadium({ rows: 6, seatsPerRow: 13 });
  const find = (section: string, row: string, number: number) => {
    const seat = seats.find((s) => s.section === section && s.row === row && s.number === number);
    if (seat === undefined) throw new Error('no such seat');
    return seat;
  };

  it('names a seat by row and number, as on a ticket', () => {
    expect(seatName(find('Fondo Sur', 'F', 12))).toBe('F-12');
  });

  it('names seats stand by stand', () => {
    expect(describeSeats([find('Fondo Sur', 'F', 12)])).toBe('F-12 in Fondo Sur');
    expect(describeSeats([find('Fondo Sur', 'F', 12), find('Fondo Sur', 'F', 13)])).toBe(
      'F-12 and F-13 in Fondo Sur',
    );
    expect(
      describeSeats([
        find('Fondo Sur', 'F', 12),
        find('Lateral Este', 'A', 1),
        find('Fondo Sur', 'F', 13),
      ]),
    ).toBe('F-12 and F-13 in Fondo Sur and A-1 in Lateral Este');
  });

  it('turns a 409 into "Someone just took F-12 in Fondo Sur. Pick another seat."', () => {
    expect(takenMessage([find('Fondo Sur', 'F', 12)])).toBe(
      'Someone just took F-12 in Fondo Sur. Pick another seat.',
    );
    expect(takenMessage([find('Fondo Sur', 'F', 12), find('Fondo Sur', 'F', 13)])).toBe(
      'Someone just took F-12 and F-13 in Fondo Sur. Pick other seats.',
    );
  });

  it('shows a picked seat as selected only while it is free', () => {
    expect(viewOf('available', false, true)).toBe('selected');
    expect(viewOf('held', false, true)).toBe('held');
    expect(viewOf('sold', false, true)).toBe('sold');
    expect(viewOf('held', true, true)).toBe('yours');
  });
});

describe('formatLeft', () => {
  it.each([
    [300_000, '5:00'],
    [299_001, '5:00'],
    [299_000, '4:59'],
    [60_000, '1:00'],
    [1, '0:01'],
    [0, '0:00'],
    [-5_000, '0:00'],
  ])('shows %i ms as %s, rounding up', (ms, text) => {
    expect(formatLeft(ms)).toBe(text);
  });
});
