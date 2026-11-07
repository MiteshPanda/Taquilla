import type { Point2, Point3 } from './venue.js';

// A pinhole camera at a fan's eyes, looking at a point of the ground: enough perspective to show
// how near, how high and how square-on a seat is, drawn as plain SVG paths.

// Nothing nearer than this is drawn, so a shape reaching behind the fan is cut, not flipped.
export const NEAR = 0.5;

export interface Camera {
  eye: Point3;
  right: Point3;
  up: Point3;
  forward: Point3;
  // Pixels per unit of x/z or y/z, and the middle of the picture.
  focal: number;
  cx: number;
  cy: number;
}

function sub(a: Point3, b: Point3): Point3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Point3, b: Point3): Point3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function unit(a: Point3): Point3 {
  const length = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / length, y: a.y / length, z: a.z / length };
}

const SKY: Point3 = { x: 0, y: 0, z: 1 };

// A camera at `eye` looking at `target`, `fov` degrees wide, for a picture `width` by `height`.
export function lookFrom(
  eye: Point3,
  target: Point3,
  width: number,
  height: number,
  fov: number,
): Camera {
  const forward = unit(sub(target, eye));
  const right = unit(cross(forward, SKY));
  const up = cross(right, forward);
  const focal = width / 2 / Math.tan((fov * Math.PI) / 360);
  return { eye, right, up, forward, focal, cx: width / 2, cy: height / 2 };
}

// A point of the ground in the camera's terms: x to the right, y up, z straight ahead.
export function toView(camera: Camera, point: Point3): Point3 {
  const d = sub(point, camera.eye);
  return { x: dot(d, camera.right), y: dot(d, camera.up), z: dot(d, camera.forward) };
}

// Where a point in the camera's terms lands on the picture. It must be at least NEAR ahead.
export function onScreen(camera: Camera, view: Point3): Point2 {
  return {
    x: camera.cx + (view.x / view.z) * camera.focal,
    y: camera.cy - (view.y / view.z) * camera.focal,
  };
}

function cut(a: Point3, b: Point3): Point3 {
  const t = (NEAR - a.z) / (b.z - a.z);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: NEAR };
}

// The part of a polygon, in the camera's terms, at least NEAR ahead (Sutherland–Hodgman).
export function clipPolygon(points: readonly Point3[]): Point3[] {
  const kept: Point3[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i] as Point3;
    const b = points[(i + 1) % points.length] as Point3;
    const aIn = a.z >= NEAR;
    const bIn = b.z >= NEAR;
    if (aIn) kept.push(a);
    if (aIn !== bIn) kept.push(cut(a, b));
  }
  return kept;
}

// The part of a segment, in the camera's terms, at least NEAR ahead, or null if none is.
export function clipSegment(a: Point3, b: Point3): [Point3, Point3] | null {
  const aIn = a.z >= NEAR;
  const bIn = b.z >= NEAR;
  if (aIn && bIn) return [a, b];
  if (!aIn && !bIn) return null;
  return aIn ? [a, cut(a, b)] : [cut(a, b), b];
}

function fixed(n: number): string {
  return String(Math.round(n * 10) / 10);
}

// A polygon of the ground as an SVG path, or '' if none of it is in front of the camera.
export function polygonPath(camera: Camera, points: readonly Point3[]): string {
  const kept = clipPolygon(points.map((point) => toView(camera, point)));
  if (kept.length < 3) return '';
  return (
    kept
      .map((view, i) => {
        const { x, y } = onScreen(camera, view);
        return `${i === 0 ? 'M' : 'L'}${fixed(x)} ${fixed(y)}`;
      })
      .join('') + 'Z'
  );
}

export interface ScreenSegment {
  from: Point2;
  to: Point2;
  // How far ahead its middle is, to size its stroke.
  depth: number;
}

// A segment of the ground on the picture, or null if none of it is in front of the camera.
export function segmentOnScreen(camera: Camera, a: Point3, b: Point3): ScreenSegment | null {
  const kept = clipSegment(toView(camera, a), toView(camera, b));
  if (kept === null) return null;
  const [p, q] = kept;
  return { from: onScreen(camera, p), to: onScreen(camera, q), depth: (p.z + q.z) / 2 };
}

export function segmentPath({ from, to }: ScreenSegment): string {
  return `M${fixed(from.x)} ${fixed(from.y)}L${fixed(to.x)} ${fixed(to.y)}`;
}
