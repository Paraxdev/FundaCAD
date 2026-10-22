// Where an origin plane can be clicked, worked out on screen so a tile seen at a slant or edge on still
// has a finger sized target, and where its name goes so an edge on tile is still named and pickable.

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
/** A name that fits the tile with this much room to spare sits in its middle. */
export const LABEL_FIT_MARGIN_PX = 6;
/** Over this much missing room the name moves fully beside the tile, so it slides out as the tile turns. */
export const LABEL_SLIDE_PX = 16;
export const LABEL_GAP_PX = 10;
const PUSH_STEP_PX = 4;
const PUSH_STEPS = 16;

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

function rectsOverlap(a: P2, b: P2, size: LabelSize, gap: number): boolean {
  return Math.abs(a.x - b.x) < size.w + gap && Math.abs(a.y - b.y) < size.h + gap;
}

function rectOverlapsPolygon(c: P2, size: LabelSize, poly: P2[]): boolean {
  const corners = [
    { x: c.x - size.w / 2, y: c.y - size.h / 2 },
    { x: c.x + size.w / 2, y: c.y - size.h / 2 },
    { x: c.x + size.w / 2, y: c.y + size.h / 2 },
    { x: c.x - size.w / 2, y: c.y + size.h / 2 },
  ];
  if (poly.length > 2 && corners.some((q) => insidePolygon(q, poly))) return true;
  if (poly.some((q) => Math.abs(q.x - c.x) <= size.w / 2 && Math.abs(q.y - c.y) <= size.h / 2)) return true;
  // An edge on tile is a line that can cross the box with no vertex inside it.
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segmentDistance(c, poly[j]!, poly[i]!) < Math.min(size.w, size.h) / 2) return true;
  }
  return false;
}

/** Each name in its tile's middle while it fits, otherwise slid out beside the tile, on the side away from the
 *  other tiles, then pushed further out until it overlaps no other name and no other tile. */
export function placeLabels(planes: PlaneOnScreen[], size: LabelSize): Record<string, P2> {
  const cluster = planes.reduce(
    (s, t) => ({ x: s.x + t.centre.x / planes.length, y: s.y + t.centre.y / planes.length }),
    {
      x: 0,
      y: 0,
    },
  );
  const out: Record<string, P2> = {};
  const moved: { plane: Plane3; dir: P2 }[] = [];
  for (const t of planes) {
    const { across, halfAcross } = tileAxes(t);
    const need = Math.abs(across.x) * size.w + Math.abs(across.y) * size.h;
    const missing = need + LABEL_FIT_MARGIN_PX - 2 * halfAcross;
    const slide = Math.min(1, Math.max(0, missing / LABEL_SLIDE_PX));
    if (slide === 0) {
      out[t.plane] = { ...t.centre };
      continue;
    }
    const away = sub(t.centre, cluster);
    const dir = dot(away, across) >= 0 ? across : { x: -across.x, y: -across.y };
    const reach = (halfAcross + need / 2 + LABEL_GAP_PX) * slide;
    out[t.plane] = { x: t.centre.x + dir.x * reach, y: t.centre.y + dir.y * reach };
    moved.push({ plane: t.plane, dir });
  }
  // The least facing moves first, it is the one whose tile cannot hold a name.
  const order = moved.sort(
    (a, b) => planes.find((t) => t.plane === a.plane)!.facing - planes.find((t) => t.plane === b.plane)!.facing,
  );
  for (const m of order) {
    for (let i = 0; i < PUSH_STEPS; i++) {
      const at = out[m.plane]!;
      const clash = planes.some(
        (t) =>
          t.plane !== m.plane &&
          (rectsOverlap(at, out[t.plane]!, size, LABEL_GAP_PX) || rectOverlapsPolygon(at, size, t.outline)),
      );
      if (!clash) break;
      out[m.plane] = { x: at.x + m.dir.x * PUSH_STEP_PX, y: at.y + m.dir.y * PUSH_STEP_PX };
    }
  }
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
