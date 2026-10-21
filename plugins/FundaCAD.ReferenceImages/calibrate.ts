// Where an image sits on its plane, and the moves that change it. Plane
// coordinates are millimetres in the plane's own frame (SketchPlane.to2D),
// image coordinates run 0 to 1 from the left edge and the top edge.

export type V2 = readonly [number, number];

export interface Placement {
  /** The image centre. */
  at: V2;
  width: number;
  /** Pixel size, which fixes the aspect. */
  px: V2;
  /** Degrees, counter clockwise about the plane normal. */
  angle: number;
  flipX?: boolean;
  flipY?: boolean;
}

export function heightOf(p: Placement): number {
  return p.px[0] > 0 ? (p.width * p.px[1]) / p.px[0] : p.width;
}

function turn(x: number, y: number, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

export function imageToPlane(p: Placement, uv: V2): [number, number] {
  const sx = p.flipX ? -1 : 1;
  const sy = p.flipY ? -1 : 1;
  const [x, y] = turn((uv[0] - 0.5) * p.width * sx, (0.5 - uv[1]) * heightOf(p) * sy, p.angle);
  return [x + p.at[0], y + p.at[1]];
}

export function planeToImage(p: Placement, xy: V2): [number, number] {
  const sx = p.flipX ? -1 : 1;
  const sy = p.flipY ? -1 : 1;
  const [x, y] = turn(xy[0] - p.at[0], xy[1] - p.at[1], -p.angle);
  return [x / (p.width * sx) + 0.5, 0.5 - y / (heightOf(p) * sy)];
}

export function onImage(p: Placement, xy: V2): boolean {
  const [u, v] = planeToImage(p, xy);
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

/** Scale about `a` so the two picked points end up `distance` apart. Null when
 *  the points coincide or the distance is not a length. */
export function calibrate<P extends Placement>(p: P, a: V2, b: V2, distance: number): P | null {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(d > 1e-9) || !Number.isFinite(distance) || !(distance > 0)) return null;
  const s = distance / d;
  return { ...p, at: [a[0] + s * (p.at[0] - a[0]), a[1] + s * (p.at[1] - a[1])], width: p.width * s };
}

/** A typed width, about the centre. */
export function withWidth<P extends Placement>(p: P, width: number): P | null {
  if (!Number.isFinite(width) || !(width > 0)) return null;
  return { ...p, width };
}

export function moved<P extends Placement>(p: P, delta: V2): P {
  return { ...p, at: [p.at[0] + delta[0], p.at[1] + delta[1]] };
}
