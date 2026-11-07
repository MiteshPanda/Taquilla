import { describe, expect, it } from 'vitest';
import type { Seat } from '../src/api/client.js';
import { standsOf } from '../src/seats/seats.js';
import type { SeatView } from '../src/seats/seats.js';
import {
  NEAR,
  clipPolygon,
  clipSegment,
  lookFrom,
  onScreen,
  polygonPath,
  toView,
} from '../src/stadium/camera.js';
import {
  EYE_HEIGHT,
  FRONT_HEIGHT,
  PITCH,
  RAKE,
  RUN_OFF,
  STAND_DEPTH,
  planOf,
  sideOf,
  spotAt,
  toCentreSpot,
  whereIs,
} from '../src/stadium/venue.js';
import type { SeatSpot } from '../src/stadium/venue.js';
import { crowdTone, viewFrom } from '../src/stadium/viewScene.js';
import type { Shape } from '../src/stadium/viewScene.js';
import { stadium } from './helpers.js';

const seed = planOf(standsOf(stadium().seats));
const spots = [...seed.byId.values()];

function spotOf(section: string, row: string, number: number): SeatSpot {
  const spot = spots.find(
    (s) => s.seat.section === section && s.seat.row === row && s.seat.number === number,
  );
  if (spot === undefined) throw new Error(`No seat ${section} ${row}-${number}`);
  return spot;
}

const allAvailable = (): SeatView => 'available';

// Every number in a shape's path, to check none is NaN or infinite.
function numbersOf(shapes: readonly Shape[]): number[] {
  return shapes.flatMap((shape) => (shape.d.match(/-?[\d.e+-]+|NaN|Infinity/g) ?? []).map(Number));
}

describe('the ground', () => {
  it('places every seed seat once, in the four stands round the pitch', () => {
    expect(seed.stands.map((stand) => stand.side)).toEqual(['north', 'south', 'east', 'west']);
    expect(seed.byId.size).toBe(2_000);
    // Each stand's middle seat in its front row, a metre into the stand behind the run-off.
    const ends = PITCH.halfLength + RUN_OFF + 1;
    const sides = PITCH.halfWidth + RUN_OFF + 1;
    const cases = [
      ['Fondo Norte', 0, ends],
      ['Fondo Sur', 0, -ends],
      ['Lateral Este', sides, 0],
      ['Lateral Oeste', -sides, 0],
    ] as const;
    for (const [stand, x, y] of cases) {
      const { at } = spotOf(stand, 'A', 13);
      expect(at.x).toBeCloseTo(x);
      expect(at.y).toBeCloseTo(y);
    }
  });

  it('puts seat 1 on a fan’s left as they face the pitch, in every stand', () => {
    // Facing north from Fondo Sur, the left is west; facing south from Fondo Norte, east.
    expect(spotOf('Fondo Sur', 'A', 1).at.x).toBeLessThan(0);
    expect(spotOf('Fondo Norte', 'A', 1).at.x).toBeGreaterThan(0);
    expect(spotOf('Lateral Oeste', 'A', 1).at.y).toBeGreaterThan(0);
    expect(spotOf('Lateral Este', 'A', 1).at.y).toBeLessThan(0);
  });

  it('raises each row above and behind the one in front, outside the pitch and its run-off', () => {
    for (const stand of seed.stands) {
      for (let r = 1; r < stand.rows.length; r += 1) {
        const [front, behind] = [stand.rows[r - 1]?.[0], stand.rows[r]?.[0]];
        expect(behind?.eye.z).toBeGreaterThan(front?.eye.z ?? Infinity);
        expect(Math.hypot(behind?.at.x ?? 0, behind?.at.y ?? 0)).toBeGreaterThan(
          Math.hypot(front?.at.x ?? 0, front?.at.y ?? 0),
        );
      }
    }
    // A seated fan's eyes are above their row's floor, which climbs with the rake.
    const frontRow = spotOf('Fondo Sur', 'A', 13);
    expect(frontRow.eye.z).toBeCloseTo(FRONT_HEIGHT + (frontRow.across / 2) * RAKE + EYE_HEIGHT);
    for (const spot of spots) {
      const outside =
        Math.abs(spot.at.x) > PITCH.halfWidth + RUN_OFF ||
        Math.abs(spot.at.y) > PITCH.halfLength + RUN_OFF;
      expect(outside).toBe(true);
    }
  });

  it('finds the seat under any point of a stand, and none on the pitch, in a corner or outside', () => {
    for (const spot of spots) expect(spotAt(seed, spot.at)).toBe(spot);
    const corner = PITCH.halfWidth + RUN_OFF + STAND_DEPTH / 2;
    for (const point of [
      { x: 0, y: 0 },
      { x: 30, y: 50 },
      { x: corner, y: PITCH.halfLength + RUN_OFF + STAND_DEPTH / 2 },
      { x: 0, y: 200 },
    ]) {
      expect(spotAt(seed, point)).toBeNull();
    }
  });

  it('leaves out a stand it has no place for', () => {
    const other = planOf(
      standsOf(stadium({ rows: 1, seatsPerRow: 2, stands: [['Tribuna', 100_000]] }).seats),
    );
    expect(sideOf('Tribuna')).toBeUndefined();
    expect(other.stands).toEqual([]);
    expect(other.byId.size).toBe(0);
  });

  it('says where a seat is and how far it is from the centre spot', () => {
    const cases = [
      ['Fondo Sur', 'A', 13, 'Behind the goal', 60],
      ['Fondo Sur', 'A', 1, 'Behind the goal, toward the corner', 71],
      // Wide of the goal but inside the box's width is still behind the goal.
      ['Fondo Sur', 'A', 8, 'Behind the goal', 62],
      ['Lateral Este', 'A', 13, 'Level with the halfway line', 41],
      ['Lateral Este', 'A', 8, 'Between halfway and the box', 47],
      ['Lateral Este', 'A', 1, 'Level with the penalty box', 70],
      ['Lateral Oeste', 'T', 13, 'Level with the halfway line', 83],
    ] as const;
    for (const [section, row, number, where, metres] of cases) {
      const spot = spotOf(section, row, number);
      expect([whereIs(spot), toCentreSpot(spot)]).toEqual([where, metres]);
    }
  });
});

describe('the camera', () => {
  // At the south goal line's middle, eyes level with the ground, looking north at the spot.
  const camera = lookFrom({ x: 0, y: -10, z: 0 }, { x: 0, y: 0, z: 0 }, 640, 400, 90);

  it('puts what it looks at in the middle, east on the right and up at the top', () => {
    expect(onScreen(camera, toView(camera, { x: 0, y: 0, z: 0 }))).toEqual({ x: 320, y: 200 });
    // 90 degrees wide: 45 degrees to the right is the picture's edge.
    expect(onScreen(camera, toView(camera, { x: 10, y: 0, z: 0 }))).toEqual({ x: 640, y: 200 });
    expect(onScreen(camera, toView(camera, { x: 0, y: 0, z: 5 })).y).toBeLessThan(200);
  });

  it('cuts shapes at the near plane rather than flipping what is behind it', () => {
    const ahead = [
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 1 },
      { x: 1, y: 1, z: 2 },
    ];
    expect(clipPolygon(ahead)).toEqual(ahead);
    expect(clipPolygon(ahead.map((p) => ({ ...p, z: -p.z })))).toEqual([]);
    const across = clipPolygon([
      { x: 0, y: 0, z: -1 },
      { x: 0, y: 0, z: 3 },
      { x: 2, y: 0, z: 3 },
    ]);
    expect(across.every((p) => p.z >= NEAR)).toBe(true);
    expect(across.filter((p) => p.z === NEAR)).toHaveLength(2);

    expect(clipSegment({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 2 })).toEqual([
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 2 },
    ]);
    expect(clipSegment({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -2 })).toBeNull();
    expect(clipSegment({ x: 0, y: 0, z: -1.5 }, { x: 0, y: 4, z: 2.5 })).toEqual([
      { x: 0, y: 2, z: NEAR },
      { x: 0, y: 4, z: 2.5 },
    ]);
  });

  it('draws nothing for a shape wholly behind it', () => {
    const behind = [
      { x: -1, y: -20, z: 0 },
      { x: 1, y: -20, z: 0 },
      { x: 0, y: -25, z: 1 },
    ];
    expect(polygonPath(camera, behind)).toBe('');
    expect(
      polygonPath(
        camera,
        behind.map((p) => ({ ...p, y: -p.y })),
      ),
    ).toMatch(/^M.*Z$/);
  });
});

describe('the view from a seat', () => {
  const paints = (shapes: readonly Shape[]) => new Set(shapes.map((shape) => shape.paint));

  it('shows the pitch, its markings and the other stands, all on the picture’s numbers', () => {
    const shapes = viewFrom(seed, spotOf('Lateral Este', 'I', 13), allAvailable);
    for (const paint of ['pitch', 'stripe', 'line', 'net', 'board', 'roof', 'light']) {
      expect(paints(shapes).has(paint as Shape['paint'])).toBe(true);
    }
    expect(paints(shapes).has('seat-open')).toBe(true);
    expect(paints(shapes).has('seat-open-alt')).toBe(true);
    expect(numbersOf(shapes).every(Number.isFinite)).toBe(true);
    for (const shape of shapes.filter((s) => s.width !== undefined)) {
      expect(shape.width).toBeGreaterThanOrEqual(0.6);
      expect(shape.width).toBeLessThanOrEqual(3.2);
    }
  });

  it('draws the rows in front of the fan, one figure a seat, and none from the front row', () => {
    const near = (shapes: readonly Shape[]) =>
      shapes.filter((s) => s.paint.startsWith('near-') && s.paint !== 'near-stand');
    // Each figure is one closed outline in its row's path.
    const figures = (shapes: readonly Shape[]) =>
      shapes.reduce((sum, s) => sum + (s.d.match(/M/g)?.length ?? 0), 0);
    expect(near(viewFrom(seed, spotOf('Lateral Este', 'A', 13), allAvailable))).toEqual([]);
    const fromRowC = near(viewFrom(seed, spotOf('Lateral Este', 'C', 13), allAvailable));
    // Two rows, one path each; seats far to the side of the fan fall outside the picture.
    expect(fromRowC).toHaveLength(2);
    expect(figures(fromRowC)).toBeGreaterThan(10);
    expect(figures(fromRowC)).toBeLessThanOrEqual(50);
    expect(new Set(fromRowC.map((s) => s.paint))).toEqual(new Set(['near-seat']));
  });

  it('paints the crowd as sold so far, holds and the fan’s own picks, from any seat', () => {
    const states = new Map<number, SeatView>();
    for (const spot of spots) {
      if (spot.side !== 'west') continue;
      const view: SeatView =
        spot.seat.number % 3 === 0 ? 'sold' : spot.seat.number % 3 === 1 ? 'held' : 'selected';
      states.set(spot.seat.id, view);
    }
    const viewOf = (seat: Seat): SeatView => states.get(seat.id) ?? 'available';
    for (const from of [spotOf('Lateral Este', 'T', 1), spotOf('Fondo Sur', 'A', 25)]) {
      const seen = paints(viewFrom(seed, from, viewOf));
      expect(seen.has('seat-held')).toBe(true);
      expect(seen.has('seat-picked')).toBe(true);
      expect([...seen].some((paint) => paint.startsWith('crowd-'))).toBe(true);
    }
  });

  it('leaves the fan’s own stand out, but for the rows in front of them', () => {
    // Every seat of Lateral Este is held, and every other seat free.
    const viewOf = (seat: Seat): SeatView =>
      seat.section === 'Lateral Este' ? 'held' : 'available';
    const seen = paints(viewFrom(seed, spotOf('Lateral Este', 'K', 13), viewOf));
    expect(seen.has('seat-held')).toBe(false);
    expect(seen.has('near-crowd') || seen.has('near-crowd-alt')).toBe(true);
    expect(seen.has('seat-open')).toBe(true);
  });

  it('gives every sold seat one of four crowd colours, always the same one', () => {
    const tones = Array.from({ length: 100 }, (_, i) => crowdTone(i + 1));
    expect(new Set(tones)).toEqual(new Set([0, 1, 2, 3]));
    expect(Array.from({ length: 100 }, (_, i) => crowdTone(i + 1))).toEqual(tones);
  });
});
