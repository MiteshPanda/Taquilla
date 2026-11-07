import { memo, useCallback, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Seat } from '../api/client.js';
import { formatPrice, seatLabel, viewOf } from './seats.js';
import type { SeatStateMap, SeatView, Stand } from './seats.js';

interface SeatButtonProps {
  seat: Seat;
  view: SeatView;
  row: number;
  column: number;
  tabbable: boolean;
  onFocusSeat: (row: number, column: number) => void;
}

// Memoised, so a poll re-renders only the seats whose state changed.
const SeatButton = memo(function SeatButton({
  seat,
  view,
  row,
  column,
  tabbable,
  onFocusSeat,
}: SeatButtonProps) {
  const label = seatLabel(seat, view);
  return (
    <button
      type="button"
      className={`seat seat-${view}`}
      data-row={row}
      data-column={column}
      tabIndex={tabbable ? 0 : -1}
      aria-label={label}
      title={label}
      // Still focusable, so a screen reader can reach a sold seat and hear that it's sold.
      aria-disabled={view === 'held' || view === 'sold' ? true : undefined}
      onFocus={() => onFocusSeat(row, column)}
    />
  );
});

type Position = readonly [row: number, column: number];

export interface StandGridProps {
  stand: Stand;
  states: SeatStateMap;
  mine: ReadonlySet<number>;
}

// One stand as a grid of seat buttons. Only one seat per stand is in the tab order, so the page
// isn't 2,000 tab stops long; the arrow keys, Home and End move between seats (a roving tabindex).
export const StandGrid = memo(function StandGrid({ stand, states, mine }: StandGridProps) {
  const [active, setActive] = useState<Position>([0, 0]);
  const grid = useRef<HTMLDivElement>(null);
  const headingId = useId();

  const onFocusSeat = useCallback((row: number, column: number) => {
    setActive((current) => (current[0] === row && current[1] === column ? current : [row, column]));
  }, []);

  const seats = stand.rows.flatMap((row) => row.seats);
  const available = seats.filter((seat) => states.get(seat.id) === 'available').length;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const [row, column] = active;
    const lastRow = stand.rows.length - 1;
    const lastColumnOf = (r: number) => (stand.rows[r]?.seats.length ?? 1) - 1;
    const targets: Record<string, Position> = {
      ArrowLeft: [row, column - 1],
      ArrowRight: [row, column + 1],
      ArrowUp: [row - 1, column],
      ArrowDown: [row + 1, column],
      Home: event.ctrlKey ? [0, 0] : [row, 0],
      End: event.ctrlKey ? [lastRow, lastColumnOf(lastRow)] : [row, lastColumnOf(row)],
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();

    const nextRow = Math.min(Math.max(target[0], 0), lastRow);
    const nextColumn = Math.min(Math.max(target[1], 0), lastColumnOf(nextRow));
    grid.current
      ?.querySelector<HTMLButtonElement>(`[data-row="${nextRow}"][data-column="${nextColumn}"]`)
      ?.focus();
  }

  return (
    <section className="stand" aria-labelledby={headingId}>
      <h3 id={headingId}>{stand.name}</h3>
      <p className="stand-summary">
        {stand.prices.map(formatPrice).join(' to ')} · {available} of {seats.length} available
      </p>
      <div className="stand-scroll">
        <div
          ref={grid}
          role="grid"
          aria-labelledby={headingId}
          className="stand-grid"
          onKeyDown={onKeyDown}
        >
          {stand.rows.map((row, r) => (
            <div role="row" key={row.label} className="seat-row">
              <span role="rowheader" className="row-label">
                {row.label}
              </span>
              {row.seats.map((seat, c) => (
                <span role="gridcell" key={seat.id}>
                  <SeatButton
                    seat={seat}
                    view={viewOf(states.get(seat.id) ?? seat.state, mine.has(seat.id))}
                    row={r}
                    column={c}
                    tabbable={active[0] === r && active[1] === c}
                    onFocusSeat={onFocusSeat}
                  />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
});
