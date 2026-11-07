import { MAX_HOLD_SEATS } from '../seats/seats.js';

// The seats a fan has picked but not yet held, in the order they picked them.
export interface Selection {
  seatIds: readonly number[];
  // The last pick was refused because the selection was already full.
  full: boolean;
}

export const EMPTY_SELECTION: Selection = { seatIds: [], full: false };

export type SelectionAction =
  // `isFree` drops picked seats someone else has taken since, so they don't count to the limit.
  | { type: 'toggle'; seatId: number; isFree: (seatId: number) => boolean }
  | { type: 'remove'; seatIds: readonly number[] }
  | { type: 'clear' };

export function selectionReducer(state: Selection, action: SelectionAction): Selection {
  switch (action.type) {
    case 'toggle': {
      const kept = state.seatIds.filter(action.isFree);
      if (kept.includes(action.seatId)) {
        return { seatIds: kept.filter((id) => id !== action.seatId), full: false };
      }
      if (kept.length >= MAX_HOLD_SEATS) return { seatIds: kept, full: true };
      return { seatIds: [...kept, action.seatId], full: false };
    }
    case 'remove':
      return {
        seatIds: state.seatIds.filter((id) => !action.seatIds.includes(id)),
        full: false,
      };
    case 'clear':
      return EMPTY_SELECTION;
  }
}
