// Where the guide's ring and caption bubble go. Pure, so it is tested without a layout engine.

import type { Box } from "../controlRefs";

export type Side = "right" | "left" | "below" | "above";

export interface Placed extends Box {
  side: Side;
}

export const GUTTER = 16;
export const GAP = 12;
export const RING_PAD = 4;

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

/** The bubble beside the target, right first, then left, below and above, inside a
 *  16 px gutter and never over the target or an `avoid` rect such as an open dialog. */
export function placeBubble(
  target: Box,
  view: { width: number; height: number },
  size: { width: number; height: number },
  avoid: Box[] = [],
): Placed {
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
  const blocked = [ring, ...avoid];
  let fallback: Placed | null = null;
  for (const [side, x, y] of tries) {
    const along = side === "right" || side === "left";
    const fits = along ? x >= GUTTER && x <= maxLeft : y >= GUTTER && y <= maxTop;
    const box: Placed = {
      side,
      left: along ? x : clamp(x, GUTTER, Math.max(GUTTER, maxLeft)),
      top: along ? clamp(y, GUTTER, Math.max(GUTTER, maxTop)) : y,
      width: size.width,
      height: size.height,
    };
    if (!fits) continue;
    if (!blocked.some((b) => intersects(box, b))) return box;
    fallback ??= box;
  }
  if (fallback && !intersects(fallback, ring)) return fallback;
  return {
    side: "below",
    left: clamp(midX, GUTTER, Math.max(GUTTER, maxLeft)),
    top: ring.top + ring.height + GAP <= maxTop ? ring.top + ring.height + GAP : GUTTER,
    width: size.width,
    height: size.height,
  };
}
