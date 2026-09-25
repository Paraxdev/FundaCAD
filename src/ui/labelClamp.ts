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
