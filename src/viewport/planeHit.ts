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
  /** Seen from the side away from the other tiles, so it is drawn over them where they overlap. */
  front?: boolean;
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

/** +1 or -1 along `across` for the side of `t` away from the other tiles, 0 with none. */
function awaySide(t: PlaneOnScreen, planes: PlaneOnScreen[], across: P2): number {
  let s = 0;
  for (const o of planes) if (o !== t) s += dot(sub(t.centre, o.centre), across);
  return Math.abs(s) < 1e-9 ? 0 : Math.sign(s);
}

function boxOverlap(a: P2, b: P2, size: LabelSize): number {
  return Math.max(0, size.w - Math.abs(a.x - b.x)) * Math.max(0, size.h - Math.abs(a.y - b.y));
}

const NAME_GAP_PX = 2;
const NAME_STEPS = 15;
/** How far a crowded name may walk from its tile's centre toward the far corner, in centre to corner lengths. */
const NAME_REACH = 0.6;
/** Where a name the walk left on another's box looks next, a 6 px grid out to 60 px, nearest first. */
const NAME_ROUND: P2[] = [];
for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) NAME_ROUND.push({ x: 6 * i, y: 6 * j });
NAME_ROUND.sort((a, b) => len(a) - len(b));

/** Each name sits at its tile's centre. A tile too thin to hold it has it beside its line, away from the other
 *  tiles. A name that would cover another name or sit on a tile drawn in front of its own walks toward its far
 *  corner, and one still on another's box looks all round. Names keep a coarse pointer's target apart, since
 *  `pickPlaneOnScreen` gives that box to its name. Tiles in front go first, then thin ones, whose names have one
 *  place beside their line, then those facing the camera most. */
export function placeLabels(planes: PlaneOnScreen[], size: LabelSize): Record<string, P2> {
  const out: Record<string, P2> = {};
  const target = { w: Math.max(size.w, HIT_MIN_COARSE_PX), h: Math.max(size.h, HIT_MIN_COARSE_PX) };
  const placed: P2[] = [];
  const thinFor = (t: PlaneOnScreen) => 2 * tileAxes(t).halfAcross < size.h;
  const order = [...planes].sort(
    (a, b) => Number(!!b.front) - Number(!!a.front) || Number(thinFor(b)) - Number(thinFor(a)) || b.facing - a.facing,
  );
  for (const t of order) {
    const { across, halfAcross } = tileAxes(t);
    const reach = Math.abs(across.x) * (size.w / 2) + Math.abs(across.y) * (size.h / 2);
    const thin = 2 * halfAcross < size.h;
    const shift = thin ? (reach + NAME_GAP_PX + halfAcross) * awaySide(t, planes, across) : 0;
    const start = { x: t.centre.x + shift * across.x, y: t.centre.y + shift * across.y };
    const toFar = { x: t.su.x + t.sv.x, y: t.su.y + t.sv.y };
    const fronts = t.front ? [] : planes.filter((o) => o !== t && o.front);
    let best = start;
    let bestScore = Infinity;
    const consider = (c: P2): number => {
      let score = 0;
      for (const q of placed) score += 1000 * boxOverlap(c, q, target);
      if (!thin && polygonDistance(c, t.outline) > 0) score += 10;
      for (const f of fronts) {
        if (polygonDistance(c, f.outline) === 0) score += 10;
        for (const dx of [-1, 0, 1])
          for (const dy of [-1, 0, 1])
            if (polygonDistance({ x: c.x + (dx * size.w) / 2, y: c.y + (dy * size.h) / 2 }, f.outline) === 0) score++;
      }
      if (score < bestScore) {
        best = c;
        bestScore = score;
      }
      return score;
    };
    for (let i = 0; i <= NAME_STEPS; i++) {
      const k = (NAME_REACH * i) / NAME_STEPS;
      if (consider({ x: start.x + k * toFar.x, y: start.y + k * toFar.y }) === 0) break;
    }
    if (bestScore >= 1000)
      for (const o of NAME_ROUND) if (consider({ x: start.x + o.x, y: start.y + o.y }) === 0) break;
    out[t.plane] = best;
    placed.push(best);
  }
  return out;
}

/** The plane a press at `p` takes. Each tile is hit inside its drawn outline or inside a box along its own axes wide
 *  enough to hold a `minPx` square, grown on the side away from the other tiles, and each name inside a box at
 *  least `minPx` square. A press on a name takes its plane, and one in the box around it does too, ahead of any
 *  drawn tile. Otherwise where targets overlap the plane whose drawn tile or name is nearest wins, then the one
 *  drawn in front, then the one facing the camera most. */
export function pickPlaneOnScreen(
  planes: PlaneOnScreen[],
  labels: Record<string, P2>,
  p: P2,
  minPx: number,
  size: LabelSize,
): PlaneHit | null {
  let best: (PlaneHit & { facing: number; front: boolean; rank: number; near: number }) | null = null;
  for (const t of planes) {
    const { long, across, halfLong, halfAcross } = tileAxes(t);
    const d = sub(p, t.centre);
    const tileD = polygonDistance(p, t.outline);
    const label = labels[t.plane];
    const labelD = label ? rectDistance(p, label, size) : Infinity;
    // A band at a slant holds a screen square only when it is wider than the square.
    const wide = minPx * (Math.abs(long.x) + Math.abs(long.y));
    const side = 2 * halfAcross < wide ? awaySide(t, planes, across) : 0;
    const lo = side > 0 ? -halfAcross : side < 0 ? halfAcross - wide : -Math.max(halfAcross, wide / 2);
    const a = dot(d, across);
    const inPad =
      Math.abs(dot(d, long)) <= Math.max(halfLong, wide / 2) && a >= lo && a <= lo + Math.max(2 * halfAcross, wide);
    const inLabelPad =
      !!label &&
      Math.abs(p.x - label.x) <= Math.max(size.w, minPx) / 2 &&
      Math.abs(p.y - label.y) <= Math.max(size.h, minPx) / 2;
    if (tileD > 0 && !inPad && !inLabelPad) continue;
    const distance = Math.min(tileD, labelD);
    const part: PlaneHitPart = labelD === 0 ? "label" : tileD === 0 ? "tile" : "pad";
    // A tile in front can hide all but a sliver of another, so the box around a name is that plane's sure target.
    const rank = labelD === 0 ? 2 : inLabelPad ? 1 : 0;
    const front = !!t.front;
    const near = rank > 0 ? labelD : distance;
    const hit = { plane: t.plane, distance, part, facing: t.facing, front, rank, near };
    const tie = !!best && rank === best.rank && Math.abs(near - best.near) <= 1e-9;
    if (
      !best ||
      rank > best.rank ||
      (rank === best.rank && near < best.near - 1e-9) ||
      (tie && front && !best.front) ||
      (tie && front === best.front && t.facing > best.facing)
    )
      best = hit;
  }
  if (!best) return null;
  return { plane: best.plane, distance: best.distance, part: best.part };
}
