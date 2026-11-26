// Where the guide's ring and caption bubble go. Pure, so it is tested without a layout engine.

import type { Box } from "../controlRefs";

export type Side = "right" | "left" | "below" | "above";

export interface Placed extends Box {
  side: Side;
}

export const GUTTER = 16;
export const GAP = 12;
export const RING_PAD = 4;
/** Below the title bar and the ribbon. */
export const CAPTION_TOP = 72;

export function ringRect(target: Box, pad = RING_PAD): Box {
  return {
    left: target.left - pad,
    top: target.top - pad,
    width: target.width + 2 * pad,
    height: target.height + 2 * pad,
  };
}

export const intersects = (a: Box, b: Box) =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

type Size = { width: number; height: number };

const clearOf = (box: Box, rects: Box[]) => !rects.some((r) => intersects(box, r));

/** The spots beside a target that fit inside the gutter, right first, then left, below and above. */
function besideSpots(target: Box, view: Size, size: Size): Placed[] {
  const ring = ringRect(target);
  const maxLeft = view.width - GUTTER - size.width;
  const maxTop = view.height - GUTTER - size.height;
  const midY = ring.top + ring.height / 2 - size.height / 2;
  const midX = ring.left + ring.width / 2 - size.width / 2;
  const tries: [Side, number, number][] = [
    ["right", ring.left + ring.width + GAP, midY],
    ["left", ring.left - GAP - size.width, midY],
    ["below", midX, ring.top + ring.height + GAP],
    ["above", midX, ring.top - GAP - size.height],
  ];
  return tries.flatMap(([side, x, y]): Placed[] => {
    const along = side === "right" || side === "left";
    const fits = along ? x >= GUTTER && x <= maxLeft : y >= GUTTER && y <= maxTop;
    if (!fits) return [];
    return [
      {
        side,
        left: along ? x : clamp(x, GUTTER, Math.max(GUTTER, maxLeft)),
        top: along ? clamp(y, GUTTER, Math.max(GUTTER, maxTop)) : y,
        width: size.width,
        height: size.height,
      },
    ];
  });
}

/** The bubble beside the target, right first, then left, below and above, inside a 16 px gutter and never over the
 *  target. It keeps off an `avoid` rect such as an open dialog where it can, and off `menus`, the open menus and
 *  submenus, always: null hides it while no spot is clear of them. */
export function placeBubble(target: Box, view: Size, size: Size, avoid: Box[] = [], menus: Box[] = []): Placed | null {
  const ring = ringRect(target);
  const maxLeft = view.width - GUTTER - size.width;
  const maxTop = view.height - GUTTER - size.height;
  const midX = ring.left + ring.width / 2 - size.width / 2;
  const last: Placed = {
    side: "below",
    left: clamp(midX, GUTTER, Math.max(GUTTER, maxLeft)),
    top: ring.top + ring.height + GAP <= maxTop ? ring.top + ring.height + GAP : GUTTER,
    width: size.width,
    height: size.height,
  };
  const spots = [...besideSpots(target, view, size), last];
  return (
    spots.find((b) => clearOf(b, [ring, ...menus, ...avoid])) ??
    spots.find((b) => clearOf(b, [ring, ...menus])) ??
    (clearOf(last, menus) ? last : null)
  );
}

/** A bubble with nothing to point at. It sits at the top centre unless that covers `work`, the open sketch, then
 *  beside the sketch. It never covers an `avoid` rect such as an open dialog or one of `menus`, and keeps off
 *  `chrome`, the rail, cards and view controls, where it can. Null while no spot is clear of an open menu. */
export function placeCaption(
  view: Size,
  size: Size,
  avoid: Box[] = [],
  keep: { work?: Box | null; chrome?: Box[] } = {},
  menus: Box[] = [],
): Placed | null {
  const top: Placed = {
    side: "below",
    left: clamp(view.width / 2 - size.width / 2, GUTTER, Math.max(GUTTER, view.width - GUTTER - size.width)),
    top: CAPTION_TOP,
    width: size.width,
    height: size.height,
  };
  const work = keep.work ?? null;
  const must = [...(work ? [ringRect(work)] : []), ...menus, ...avoid];
  const spots = [top, ...(work ? besideSpots(work, view, size) : [])];
  const spot = spots.find((b) => clearOf(b, [...must, ...(keep.chrome ?? [])])) ?? spots.find((b) => clearOf(b, must));
  if (spot) return spot;
  const over = [...avoid, ...menus].find((b) => intersects(top, b));
  return over ? placeBubble(over, view, size, avoid, menus) : top;
}
