import { memo, useCallback, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, PointerEvent } from 'react';
import type { Seat } from '../api/client.js';
import { seatLabel, viewOf } from './seats.js';
import type { SeatStateMap, SeatView, Stand } from './seats.js';

interface SeatButtonProps {
  seat: Seat;
  view: SeatView;
  row: number;
  column: number;
  tabbable: boolean;
  onFocusSeat: (row: number, column: number) => void;
  // Picks or unpicks the seat; absent while seats can't be picked, as during a hold.
  onToggleSeat: ((seat: Seat) => void) | undefined;
}

// Memoised, so a poll re-renders only the seats whose state changed.
const SeatButton = memo(function SeatButton({
  seat,
  view,
  row,
  column,
  tabbable,
  onFocusSeat,
  onToggleSeat,
}: SeatButtonProps) {
  const label = seatLabel(seat, view);
  const pickable = onToggleSeat !== undefined && (view === 'available' || view === 'selected');
  return (
    <button
      type="button"
      className={`seat seat-${view}`}
      data-seat={seat.id}
      data-row={row}
      data-column={column}
      tabIndex={tabbable ? 0 : -1}
      aria-label={label}
      title={label}
      // A seat that can be picked is a toggle. One that can't stays focusable, so a screen
      // reader can still reach a sold seat and hear that it's sold.
      aria-pressed={pickable ? view === 'selected' : undefined}
      aria-disabled={pickable ? undefined : true}
      onFocus={() => onFocusSeat(row, column)}
      onClick={pickable ? () => onToggleSeat(seat) : undefined}
    />
  );
});

type Position = readonly [row: number, column: number];

export interface StandGridProps {
  stand: Stand;
  states: SeatStateMap;
  mine: ReadonlySet<number>;
  selected: ReadonlySet<number>;
  onToggleSeat: ((seat: Seat) => void) | undefined;
  // The seat under the pointer or keyboard focus, so the plan and the view can show it; null when
  // neither is on a seat.
  onPoint: (seatId: number | null) => void;
}

// The seat a pointer or focus event came from, if any.
function seatOf(target: EventTarget | null): number | null {
  const seat = target instanceof Element ? target.closest('[data-seat]') : null;
  return seat === null ? null : Number(seat.getAttribute('data-seat'));
}

// One stand as a grid of seat buttons, laid out as a fan sees it facing the pitch: row A nearest
// the pitch at the top, seat 1 on the left. Only one seat is in the tab order, so the stand isn't
// 500 tab stops long; the arrow keys, Home and End move between seats (a roving tabindex).
export const StandGrid = memo(function StandGrid({
  stand,
  states,
  mine,
  selected,
  onToggleSeat,
  onPoint,
}: StandGridProps) {
  const [active, setActive] = useState<Position>([0, 0]);
  const grid = useRef<HTMLDivElement>(null);

  const onFocusSeat = useCallback((row: number, column: number) => {
    setActive((current) => (current[0] === row && current[1] === column ? current : [row, column]));
  }, []);

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

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) onPoint(null);
  }

  return (
    <div className="stand-scroll">
      <p className="pitch-edge" aria-hidden="true">
        Pitch
      </p>
      <div
        ref={grid}
        role="grid"
        aria-label={stand.name}
        className="stand-grid"
        onKeyDown={onKeyDown}
        onPointerOver={(event: PointerEvent<HTMLDivElement>) => {
          const seatId = seatOf(event.target);
          if (seatId !== null) onPoint(seatId);
        }}
        onPointerLeave={() => onPoint(null)}
        onFocus={(event) => onPoint(seatOf(event.target))}
        onBlur={onBlur}
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
                  view={viewOf(
                    states.get(seat.id) ?? seat.state,
                    mine.has(seat.id),
                    selected.has(seat.id),
                  )}
                  row={r}
                  column={c}
                  tabbable={active[0] === r && active[1] === c}
                  onFocusSeat={onFocusSeat}
                  onToggleSeat={onToggleSeat}
                />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
});
