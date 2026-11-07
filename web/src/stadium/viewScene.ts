import type { SeatView } from '../seats/seats.js';
import { lookFrom, polygonPath, segmentOnScreen, segmentPath } from './camera.js';
import type { Camera } from './camera.js';
import {
  FRAMES,
  FRONT_HEIGHT,
  GOAL,
  PITCH,
  RAKE,
  ROOF_REACH,
  ROOF_RISE,
  RUN_OFF,
  STAND_DEPTH,
  STRIPES,
  pitchLines,
  pitchSpots,
} from './venue.js';
import type { Frame, Point2, Point3, SeatSpot, StandPlan, VenuePlan } from './venue.js';

// The view from a seat, as SVG paths painted far to near: the other stands with their crowds and
// roofs, the pitch and its markings, then the rows in front of the fan and the roof above them.

export const VIEW_WIDTH = 640;
export const VIEW_HEIGHT = 400;
// About what a fan takes in without turning their head.
export const VIEW_FOV = 75;

export type Paint =
  | 'stand'
  | 'wall'
  | 'roof'
  | 'fascia'
  | 'corner'
  | 'seat-open'
  | 'seat-open-alt'
  | 'seat-held'
  | 'seat-picked'
  | 'crowd-0'
  | 'crowd-1'
  | 'crowd-2'
  | 'crowd-3'
  | 'apron'
  | 'pitch'
  | 'stripe'
  | 'board'
  | 'board-edge'
  | 'near-stand'
  | 'near-seat'
  | 'near-crowd'
  | 'near-crowd-alt'
  | 'line'
  | 'spot'
  | 'net'
  | 'light';

export interface Shape {
  paint: Paint;
  d: string;
  // Lines only: their stroke, in pixels.
  width?: number;
}

const TOP = FRONT_HEIGHT + STAND_DEPTH * RAKE;
const ROOF = TOP + ROOF_RISE;
const ENDS = PITCH.halfLength + RUN_OFF;
const SIDES = PITCH.halfWidth + RUN_OFF;

// A point of a stand at a given height, `depth` metres out and `along` metres toward a fan's left.
function at(frame: Frame, depth: number, along: number, z: number): Point3 {
  return {
    x: -frame.inward.x * depth + frame.left.x * along,
    y: -frame.inward.y * depth + frame.left.y * along,
    z,
  };
}

function onRake(frame: Frame, depth: number, along: number, lift = 0): Point3 {
  return at(frame, depth, along, FRONT_HEIGHT + (depth - frame.front) * RAKE + lift);
}

// Spreads the crowd's colours evenly but always the same way for a seat.
export function crowdTone(seatId: number): 0 | 1 | 2 | 3 {
  return ((Math.imul(seatId, 2654435761) >>> 29) % 4) as 0 | 1 | 2 | 3;
}

function seatPaint(view: SeatView, seatId: number): Paint {
  switch (view) {
    case 'available':
      return 'seat-open';
    case 'held':
      return 'seat-held';
    case 'selected':
    case 'yours':
      return 'seat-picked';
    case 'sold':
      return `crowd-${crowdTone(seatId)}`;
  }
}

class Painter {
  readonly shapes: Shape[] = [];
  constructor(readonly camera: Camera) {}

  fill(paint: Paint, points: readonly Point3[]) {
    const d = polygonPath(this.camera, points);
    if (d !== '') this.shapes.push({ paint, d });
  }

  // Shapes that never overlap one another, such as one stand's seats, painted together: one path
  // a paint, so a sold-out stand is a handful of elements rather than hundreds.
  group(paint: (add: (paint: Paint, points: readonly Point3[]) => void) => void) {
    const paths = new Map<Paint, string>();
    paint((each, points) => {
      const d = polygonPath(this.camera, points);
      if (d !== '') paths.set(each, (paths.get(each) ?? '') + d);
    });
    for (const [each, d] of paths) this.shapes.push({ paint: each, d });
  }

  // Lines thin out with distance, as a 12 cm painted line does, within what a screen can show.
  stroke(paint: Paint, points: readonly Point3[], metres = 0.12, step = 8) {
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i] as Point3;
      const b = points[i + 1] as Point3;
      const pieces = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step));
      for (let k = 0; k < pieces; k += 1) {
        const from = lerp(a, b, k / pieces);
        const to = lerp(a, b, (k + 1) / pieces);
        const segment = segmentOnScreen(this.camera, from, to);
        if (segment === null) continue;
        const width =
          Math.round(
            Math.min(Math.max((metres * this.camera.focal) / segment.depth, 0.6), 3.2) * 5,
          ) / 5;
        const last = this.shapes.at(-1);
        if (last !== undefined && last.paint === paint && last.width === width) {
          last.d += segmentPath(segment);
        } else {
          this.shapes.push({ paint, d: segmentPath(segment), width });
        }
      }
    }
  }
}

function lerp(a: Point3, b: Point3, t: number): Point3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function onGround({ x, y }: Point2, z = 0): Point3 {
  return { x, y, z };
}

// Seats in a row that share a paint, as one strip.
function runs(row: readonly SeatSpot[], paintOf: (spot: SeatSpot) => Paint) {
  const found: { paint: Paint; first: number; last: number }[] = [];
  row.forEach((spot, c) => {
    const paint = paintOf(spot);
    const current = found.at(-1);
    if (current !== undefined && current.paint === paint && current.last === c - 1) {
      current.last = c;
    } else {
      found.push({ paint, first: c, last: c });
    }
  });
  return found;
}

// Every other row of empty seats a shade lighter, as rows catch the floodlights.
function shaded(paintOf: (spot: SeatSpot) => Paint) {
  return (spot: SeatSpot): Paint => {
    const paint = paintOf(spot);
    return paint === 'seat-open' && spot.row % 2 === 1 ? 'seat-open-alt' : paint;
  };
}

// The roof's front edge: its face, and the floodlights under it.
function paintRoofEdge(painter: Painter, from: Point3, to: Point3) {
  painter.fill('fascia', [from, to, { ...to, z: to.z - 1.6 }, { ...from, z: from.z - 1.6 }]);
  painter.stroke(
    'light',
    [
      { ...from, z: from.z - 1.9 },
      { ...to, z: to.z - 1.9 },
    ],
    0.5,
    12,
  );
}

function paintStand(painter: Painter, plan: StandPlan, seatPaintOf: (spot: SeatSpot) => Paint) {
  const paintOf = shaded(seatPaintOf);
  const { frame, rows } = plan;
  const back = frame.front + STAND_DEPTH;
  const span = frame.halfSpan;
  painter.fill('stand', [
    onRake(frame, frame.front, span),
    onRake(frame, frame.front, -span),
    onRake(frame, back, -span),
    onRake(frame, back, span),
  ]);
  painter.group((add) => {
    for (const row of rows) {
      const first = row[0];
      if (first === undefined) continue;
      const near = frame.front + first.row * first.across + first.across * 0.14;
      const far = near + first.across * 0.72;
      for (const run of runs(row, paintOf)) {
        const from = span - run.first * first.along - first.along * 0.06;
        const to = span - (run.last + 1) * first.along + first.along * 0.06;
        add(run.paint, [
          onRake(frame, near, from),
          onRake(frame, near, to),
          onRake(frame, far, to),
          onRake(frame, far, from),
        ]);
      }
    }
  });
  painter.fill('wall', [
    at(frame, back, span, TOP),
    at(frame, back, -span, TOP),
    at(frame, back, -span, ROOF),
    at(frame, back, span, ROOF),
  ]);
  const edge = back - ROOF_REACH;
  painter.fill('roof', [
    at(frame, back + 2, span, ROOF + 0.4),
    at(frame, back + 2, -span, ROOF + 0.4),
    at(frame, edge, -span, ROOF),
    at(frame, edge, span, ROOF),
  ]);
  paintRoofEdge(painter, at(frame, edge, span, ROOF), at(frame, edge, -span, ROOF));
}

// The four corners between the stands: no seats, just the bowl's structure and its floodlights.
function paintCorner(painter: Painter, sx: number, sy: number) {
  const out = STAND_DEPTH;
  painter.fill('corner', [
    { x: sx * SIDES, y: sy * ENDS, z: FRONT_HEIGHT },
    { x: sx * (SIDES + out), y: sy * ENDS, z: TOP },
    { x: sx * (SIDES + out), y: sy * (ENDS + out), z: TOP },
    { x: sx * SIDES, y: sy * (ENDS + out), z: TOP },
  ]);
  const ring = [
    { x: sx * (SIDES + out), y: sy * ENDS },
    { x: sx * (SIDES + out), y: sy * (ENDS + out) },
    { x: sx * SIDES, y: sy * (ENDS + out) },
  ];
  for (let i = 0; i + 1 < ring.length; i += 1) {
    const a = ring[i] as Point2;
    const b = ring[i + 1] as Point2;
    painter.fill('wall', [
      onGround(a, TOP),
      onGround(b, TOP),
      onGround(b, ROOF),
      onGround(a, ROOF),
    ]);
  }
  const reach = out - ROOF_REACH;
  const inner = [
    { x: sx * SIDES, y: sy * (ENDS + reach) },
    { x: sx * (SIDES + reach), y: sy * ENDS },
  ];
  painter.fill('roof', [
    onGround(inner[0] as Point2, ROOF),
    { x: sx * SIDES, y: sy * (ENDS + out + 2), z: ROOF + 0.4 },
    { x: sx * (SIDES + out + 2), y: sy * (ENDS + out + 2), z: ROOF + 0.4 },
    { x: sx * (SIDES + out + 2), y: sy * ENDS, z: ROOF + 0.4 },
    onGround(inner[1] as Point2, ROOF),
  ]);
  paintRoofEdge(painter, onGround(inner[0] as Point2, ROOF), onGround(inner[1] as Point2, ROOF));
}

function paintPitch(painter: Painter) {
  const { halfLength: L, halfWidth: W } = PITCH;
  painter.fill('apron', [
    { x: -SIDES, y: -ENDS, z: 0 },
    { x: SIDES, y: -ENDS, z: 0 },
    { x: SIDES, y: ENDS, z: 0 },
    { x: -SIDES, y: ENDS, z: 0 },
  ]);
  painter.fill('pitch', [
    { x: -W, y: -L, z: 0 },
    { x: W, y: -L, z: 0 },
    { x: W, y: L, z: 0 },
    { x: -W, y: L, z: 0 },
  ]);
  const band = (2 * L) / STRIPES;
  for (let i = 1; i < STRIPES; i += 2) {
    const y0 = -L + i * band;
    painter.fill('stripe', [
      { x: -W, y: y0, z: 0 },
      { x: W, y: y0, z: 0 },
      { x: W, y: y0 + band, z: 0 },
      { x: -W, y: y0 + band, z: 0 },
    ]);
  }
}

function paintMarkings(painter: Painter) {
  for (const line of pitchLines()) {
    painter.stroke(
      'line',
      line.map((point) => onGround(point)),
    );
  }
  for (const spot of pitchSpots()) {
    const ring: Point3[] = [];
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * 2 * Math.PI;
      ring.push({ x: spot.x + 0.3 * Math.cos(a), y: spot.y + 0.3 * Math.sin(a), z: 0 });
    }
    painter.fill('spot', ring);
  }
  for (const end of [1, -1]) {
    const y = end * PITCH.halfLength;
    const back = y + end * GOAL.depth;
    const { halfWidth: g, height: h } = GOAL;
    painter.stroke(
      'net',
      [
        { x: -g, y, z: h },
        { x: -g, y: back, z: h * 0.75 },
        { x: g, y: back, z: h * 0.75 },
        { x: g, y, z: h },
      ],
      0.05,
    );
    painter.stroke(
      'net',
      [
        { x: -g, y: back, z: h * 0.75 },
        { x: -g, y: back, z: 0 },
      ],
      0.05,
    );
    painter.stroke(
      'net',
      [
        { x: g, y: back, z: h * 0.75 },
        { x: g, y: back, z: 0 },
      ],
      0.05,
    );
    painter.stroke(
      'line',
      [
        { x: -g, y, z: 0 },
        { x: -g, y, z: h },
        { x: g, y, z: h },
        { x: g, y, z: 0 },
      ],
      0.14,
      3,
    );
  }
}

function paintBoard(painter: Painter, frame: Frame) {
  const span = frame.halfSpan;
  painter.fill('board', [
    at(frame, frame.front, span, 0),
    at(frame, frame.front, -span, 0),
    at(frame, frame.front, -span, FRONT_HEIGHT),
    at(frame, frame.front, span, FRONT_HEIGHT),
  ]);
  painter.stroke(
    'board-edge',
    [at(frame, frame.front, span, FRONT_HEIGHT), at(frame, frame.front, -span, FRONT_HEIGHT)],
    0.08,
  );
}

// The rows in front of the fan, seen from behind, front row first: the stand's steps, then on
// each the back of an empty seat or of the fan sitting in it.
function paintRowsAhead(painter: Painter, plan: StandPlan, from: SeatSpot, viewOf: ViewOf) {
  const { frame } = plan;
  const span = frame.halfSpan;
  if (from.row > 0) {
    const ahead = frame.front + from.row * from.across;
    painter.fill('near-stand', [
      onRake(frame, frame.front, span),
      onRake(frame, frame.front, -span),
      onRake(frame, ahead, -span),
      onRake(frame, ahead, span),
    ]);
  }
  for (const row of plan.rows.slice(0, from.row)) {
    painter.group((add) => {
      for (const [c, spot] of row.entries()) {
        const depth = frame.front + (spot.row + 0.72) * spot.across;
        const floor = FRONT_HEIGHT + (depth - frame.front) * RAKE;
        const middle = span - (c + 0.5) * spot.along;
        const empty = viewOf(spot.seat) === 'available';
        const half = spot.along * (empty ? 0.36 : 0.3);
        const top = floor + (empty ? 0.75 : 1.05);
        add(
          empty ? 'near-seat' : crowdTone(spot.seat.id) % 2 === 0 ? 'near-crowd' : 'near-crowd-alt',
          [
            at(frame, depth, middle + half, floor),
            at(frame, depth, middle - half, floor),
            at(frame, depth, middle - half * 0.8, top),
            at(frame, depth, middle + half * 0.8, top),
          ],
        );
      }
    });
  }
}

function paintRoofAbove(painter: Painter, frame: Frame) {
  const back = frame.front + STAND_DEPTH;
  const edge = back - ROOF_REACH;
  const span = frame.halfSpan;
  painter.fill('roof', [
    at(frame, back + 2, span, ROOF + 0.4),
    at(frame, back + 2, -span, ROOF + 0.4),
    at(frame, edge, -span, ROOF),
    at(frame, edge, span, ROOF),
  ]);
  paintRoofEdge(painter, at(frame, edge, span, ROOF), at(frame, edge, -span, ROOF));
}

export type ViewOf = (seat: SeatSpot['seat']) => SeatView;

function distance(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// Everything a fan in `from` sees, looking at the centre spot, far to near.
export function viewFrom(plan: VenuePlan, from: SeatSpot, viewOf: ViewOf): Shape[] {
  const camera = lookFrom(from.eye, { x: 0, y: 0, z: 0 }, VIEW_WIDTH, VIEW_HEIGHT, VIEW_FOV);
  const painter = new Painter(camera);
  const paintOf = (spot: SeatSpot) => seatPaint(viewOf(spot.seat), spot.seat.id);

  const far: { distance: number; paint: () => void }[] = [];
  for (const stand of plan.stands) {
    if (stand.side === from.side) continue;
    const middle = onRake(stand.frame, stand.frame.front + STAND_DEPTH / 2, 0);
    far.push({
      distance: distance(from.eye, middle),
      paint: () => paintStand(painter, stand, paintOf),
    });
  }
  for (const [sx, sy] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    const middle = {
      x: sx * (SIDES + STAND_DEPTH / 2),
      y: sy * (ENDS + STAND_DEPTH / 2),
      z: TOP / 2,
    };
    far.push({ distance: distance(from.eye, middle), paint: () => paintCorner(painter, sx, sy) });
  }
  far.sort((a, b) => b.distance - a.distance);
  for (const item of far) item.paint();

  paintPitch(painter);
  const own = FRAMES[from.side];
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    if (side !== from.side) paintBoard(painter, FRAMES[side]);
  }
  paintMarkings(painter);
  paintBoard(painter, own);
  const ownPlan = plan.stands.find((stand) => stand.side === from.side);
  if (ownPlan !== undefined) paintRowsAhead(painter, ownPlan, from, viewOf);
  paintRoofAbove(painter, own);
  return painter.shapes;
}
