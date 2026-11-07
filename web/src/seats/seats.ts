import type { Seat, SeatState, SeatStates } from '../api/client.js';

// The seed's one match (FR-SEAT-4).
export const EVENT_ID = 1;

// A seat as this fan sees it: their own held seats are told apart from everyone else's (FR-WEB-1).
export type SeatView = SeatState | 'yours';

export const SEAT_VIEWS: readonly SeatView[] = ['available', 'held', 'yours', 'sold'];

export interface Row {
  label: string;
  seats: readonly Seat[];
}

export interface Stand {
  name: string;
  rows: readonly Row[];
  // Every price in the stand, lowest first, in paise.
  prices: readonly number[];
}

export type SeatStateMap = ReadonlyMap<number, SeatState>;

// Groups the map's seats into stands and rows, keeping the API's section, row and seat order.
export function standsOf(seats: readonly Seat[]): Stand[] {
  const stands = new Map<string, Map<string, Seat[]>>();
  for (const seat of seats) {
    let rows = stands.get(seat.section);
    if (rows === undefined) {
      rows = new Map();
      stands.set(seat.section, rows);
    }
    let row = rows.get(seat.row);
    if (row === undefined) {
      row = [];
      rows.set(seat.row, row);
    }
    row.push(seat);
  }

  return [...stands].map(([name, rows]) => ({
    name,
    rows: [...rows].map(([label, rowSeats]) => ({ label, seats: rowSeats })),
    prices: [...new Set([...rows.values()].flat().map((seat) => seat.pricePaise))].sort(
      (a, b) => a - b,
    ),
  }));
}

// Each seat's state as the full map gave it.
export function statesOf(seats: readonly Seat[]): Map<number, SeatState> {
  return new Map(seats.map((seat) => [seat.id, seat.state]));
}

// Each seat's state from a poll: held or sold if listed, available otherwise. Ids the map
// doesn't have are ignored.
export function statesFrom(
  seats: readonly Seat[],
  { held, sold }: SeatStates,
): Map<number, SeatState> {
  const heldIds = new Set(held);
  const soldIds = new Set(sold);
  return new Map(
    seats.map((seat) => [
      seat.id,
      soldIds.has(seat.id) ? 'sold' : heldIds.has(seat.id) ? 'held' : 'available',
    ]),
  );
}

export function sameStates(a: SeatStateMap, b: SeatStateMap): boolean {
  if (a.size !== b.size) return false;
  for (const [id, state] of a) {
    if (b.get(id) !== state) return false;
  }
  return true;
}

export function viewOf(state: SeatState, mine: boolean): SeatView {
  return state === 'held' && mine ? 'yours' : state;
}

const VIEW_WORDS: Record<SeatView, string> = {
  available: 'available',
  held: 'held by another fan',
  yours: 'held by you',
  sold: 'sold',
};

export const LEGEND: Record<SeatView, string> = {
  available: 'Available',
  held: 'Held by another fan',
  yours: 'Held by you',
  sold: 'Sold',
};

// What a screen reader says for a seat, such as "Fondo Sur, row F, seat 12, available".
export function seatLabel(seat: Seat, view: SeatView): string {
  return `${seat.section}, row ${seat.row}, seat ${seat.number}, ${VIEW_WORDS[view]}`;
}

const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

// Integer paise to rupees without floating point (NFR-15): ₹4,500, or ₹4,500.50.
export function formatPrice(paise: number): string {
  const whole = rupees.format(Math.trunc(paise / 100));
  const rest = paise % 100;
  return rest === 0 ? whole : `${whole}.${String(rest).padStart(2, '0')}`;
}
