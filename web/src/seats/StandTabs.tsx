import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { sideOf } from '../stadium/venue.js';
import type { Side } from '../stadium/venue.js';
import { formatPrice } from './seats.js';
import type { SeatStateMap, Stand } from './seats.js';

// Where a stand is, as a thumbnail of the ground with its side lit.
function StandGlyph({ side }: { side: Side | undefined }) {
  const lit: Record<Side, { x: number; y: number; width: number; height: number }> = {
    north: { x: 6, y: 1, width: 10, height: 4 },
    south: { x: 6, y: 23, width: 10, height: 4 },
    east: { x: 17, y: 6, width: 4, height: 16 },
    west: { x: 1, y: 6, width: 4, height: 16 },
  };
  return (
    <svg className="stand-glyph" viewBox="0 0 22 28" aria-hidden="true">
      <rect x={0.5} y={0.5} width={21} height={27} rx={6} className="stand-glyph-bowl" />
      <rect x={6.5} y={6.5} width={9} height={15} rx={0.5} className="stand-glyph-pitch" />
      {side !== undefined && <rect {...lit[side]} rx={1} className="stand-glyph-lit" />}
    </svg>
  );
}

export interface StandTabsProps {
  stands: readonly Stand[];
  active: Stand;
  states: SeatStateMap;
  // Names the tabs and the panel they show, which carries `${idBase}-panel`.
  idBase: string;
  onChoose: (standName: string) => void;
}

// One tab per stand, with its price and how many seats are left. The arrow keys move between them.
export function StandTabs({ stands, active, states, idBase, onChoose }: StandTabsProps) {
  const list = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const at = stands.indexOf(active);
    const last = stands.length - 1;
    const targets: Record<string, number> = {
      ArrowLeft: at === 0 ? last : at - 1,
      ArrowRight: at === last ? 0 : at + 1,
      Home: 0,
      End: last,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    const stand = stands[target];
    if (stand === undefined) return;
    event.preventDefault();
    onChoose(stand.name);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  }

  return (
    <div ref={list} role="tablist" aria-label="Stands" className="stand-tabs" onKeyDown={onKeyDown}>
      {stands.map((stand, i) => {
        const seats = stand.rows.flatMap((row) => row.seats);
        const left = seats.filter((seat) => states.get(seat.id) === 'available').length;
        const chosen = stand === active;
        return (
          <button
            key={stand.name}
            type="button"
            role="tab"
            id={`${idBase}-tab-${i}`}
            className="stand-tab"
            aria-selected={chosen}
            aria-controls={`${idBase}-panel`}
            tabIndex={chosen ? 0 : -1}
            onClick={() => onChoose(stand.name)}
          >
            <StandGlyph side={sideOf(stand.name)} />
            <span className="stand-tab-name">{stand.name}</span>{' '}
            <span className="stand-tab-price">{stand.prices.map(formatPrice).join(' to ')}</span>{' '}
            <span className="stand-tab-left">
              {left} of {seats.length} available
            </span>
          </button>
        );
      })}
    </div>
  );
}
