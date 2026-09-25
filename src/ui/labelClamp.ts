// Keeps a sketch dimension label where it can be read. The viewport runs full
// bleed under the floating columns, so a label projected near the left edge
// landed under the Items card (PH-3).

import type { Box } from "./promptPlacement";

/** The centre a label of half size `hw` x `hh`, projected to (`x`, `y`), is
 *  drawn at: inside `area`, and clear of the left and right columns' cards it
 *  shares a row with, `gap` from each. A card that misses the label's row is
 *  ignored. When the free span is too narrow for the label, the left card is
 *  preferred over the right, the same order as the prompt. */
export function clampLabel(
  x: number,
  y: number,
  hw: number,
  hh: number,
  area: Box,
  cards: { left: readonly Box[]; right: readonly Box[] },
  gap: number,
): { x: number; y: number } {
  const cy = Math.max(area.top + gap + hh, Math.min(y, area.bottom - gap - hh));
  let lo = area.left + gap + hw;
  let hi = area.right - gap - hw;
  const inRow = (o: Box) =>
    o.right > o.left && o.bottom > o.top && o.bottom > cy - hh && o.top < cy + hh;
  for (const o of cards.right) if (inRow(o)) hi = Math.min(hi, o.left - gap - hw);
  for (const o of cards.left) if (inRow(o)) lo = Math.max(lo, o.right + gap + hw);
  return { x: Math.max(lo, Math.min(x, hi)), y: cy };
}

/** The leader from a label drawn at `c` (half size `hw` x `hh`) back to `p`,
 *  where its dimension put it, for a label `clampLabel` had to move. It starts
 *  on the label's border, facing `p`. Null when the label is on its spot, or
 *  so near that a line would only be a stub. */
export function labelLeader(
  c: { x: number; y: number },
  hw: number,
  hh: number,
  p: { x: number; y: number },
  minPx = 6,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  if (t >= 1) return null; // p is under the label
  const x1 = c.x + dx * t;
  const y1 = c.y + dy * t;
  if (Math.hypot(p.x - x1, p.y - y1) < minPx) return null;
  return { x1, y1, x2: p.x, y2: p.y };
}
