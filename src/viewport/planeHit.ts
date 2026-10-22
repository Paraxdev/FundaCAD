// Where an origin plane can be clicked, worked out on screen so a tile seen at a slant or edge on still
// has a finger sized target, and where its name goes.

import type { Plane3 } from "../types";

export interface P2 {
  x: number;
  y: number;
}

/** One tile as drawn, in client pixels. `su` and `sv` run from the centre to the middle of two sides. */
export interface PlaneOnScreen {
  plane: Plane3;
  centre: P2;
  outline: P2[];
  su: P2;
  sv: P2;
  /** |normal . to eye|, 1 square on, 0 edge on. */
  facing: number;
}

export interface LabelSize {
  w: number;
  h: number;
}

export type PlaneHitPart = "tile" | "label" | "pad";
export interface PlaneHit {
  plane: Plane3;
  /** Pixels from the pointer to the nearest drawn part of the plane, tile or name, 0 on it. */
  distance: number;
  part: PlaneHitPart;
}

export const HIT_MIN_PX = 44;
export const HIT_MIN_COARSE_PX = 48;

export function planeHitMinPx(coarseMedia: boolean, lastPointerType: string | null): number {
  return coarseMedia || lastPointerType === "touch" ? HIT_MIN_COARSE_PX : HIT_MIN_PX;
}

const sub = (a: P2, b: P2): P2 => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: P2, b: P2) => a.x * b.x + a.y * b.y;
const len = (a: P2) => Math.hypot(a.x, a.y);

/** The tile's long axis on screen, its narrow axis across it, and how far the outline reaches along each. */
export function tileAxes(t: PlaneOnScreen): { long: P2; across: P2; halfLong: number; halfAcross: number } {
  const a = len(t.su) >= len(t.sv) ? t.su : t.sv;
  const l = len(a);
  const long = l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
  const across = { x: -long.y, y: long.x };
  let halfLong = 0;
  let halfAcross = 0;
  for (const p of t.outline) {
    const d = sub(p, t.centre);
    halfLong = Math.max(halfLong, Math.abs(dot(d, long)));
    halfAcross = Math.max(halfAcross, Math.abs(dot(d, across)));
  }
  return { long, across, halfLong, halfAcross };
}

function insidePolygon(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segmentDistance(p: P2, a: P2, b: P2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0;
  return Math.hypot(p.x - (a.x + ab.x * t), p.y - (a.y + ab.y * t));
}

/** 0 inside, otherwise to the nearest edge, so an edge on tile drawn as a line still has a distance. */
export function polygonDistance(p: P2, poly: P2[]): number {
  if (poly.length > 2 && insidePolygon(p, poly)) return 0;
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    d = Math.min(d, segmentDistance(p, poly[j]!, poly[i]!));
  return d;
}

function rectDistance(p: P2, c: P2, size: LabelSize): number {
  const dx = Math.max(0, Math.abs(p.x - c.x) - size.w / 2);
  const dy = Math.max(0, Math.abs(p.y - c.y) - size.h / 2);
  return Math.hypot(dx, dy);
}

/** Each name sits at the projected centre of its own tile, at every angle. */
export function placeLabels(planes: PlaneOnScreen[]): Record<string, P2> {
  const out: Record<string, P2> = {};
  for (const t of planes) out[t.plane] = { ...t.centre };
  return out;
}

/** The plane a press at `p` takes. Each tile is hit inside its drawn outline or inside a box along its own axes at
 *  least `minPx` across, and each name inside a box at least `minPx` square. Where targets overlap the plane whose
 *  drawn tile or name is nearest wins, then the one facing the camera most. */
export function pickPlaneOnScreen(
  planes: PlaneOnScreen[],
  labels: Record<string, P2>,
  p: P2,
  minPx: number,
  size: LabelSize,
): PlaneHit | null {
  let best: (PlaneHit & { facing: number }) | null = null;
  for (const t of planes) {
    const { long, across, halfLong, halfAcross } = tileAxes(t);
    const d = sub(p, t.centre);
    const tileD = polygonDistance(p, t.outline);
    const label = labels[t.plane];
    const labelD = label ? rectDistance(p, label, size) : Infinity;
    const inPad =
      Math.abs(dot(d, long)) <= Math.max(halfLong, minPx / 2) &&
      Math.abs(dot(d, across)) <= Math.max(halfAcross, minPx / 2);
    const inLabelPad =
      !!label &&
      Math.abs(p.x - label.x) <= Math.max(size.w, minPx) / 2 &&
      Math.abs(p.y - label.y) <= Math.max(size.h, minPx) / 2;
    if (tileD > 0 && !inPad && !inLabelPad) continue;
    const distance = Math.min(tileD, labelD);
    const part: PlaneHitPart = labelD === 0 ? "label" : tileD === 0 ? "tile" : "pad";
    const hit = { plane: t.plane, distance, part, facing: t.facing };
    if (
      !best ||
      distance < best.distance - 1e-9 ||
      (Math.abs(distance - best.distance) <= 1e-9 && t.facing > best.facing)
    )
      best = hit;
  }
  if (!best) return null;
  return { plane: best.plane, distance: best.distance, part: best.part };
}
