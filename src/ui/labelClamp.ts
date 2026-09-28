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
  cards: Cards,
  gap: number,
): { x: number; y: number } {
  const cy = Math.max(area.top + gap + hh, Math.min(y, area.bottom - gap - hh));
  const s = rowSpan(cy, hw, hh, area, cards, gap);
  return { x: Math.max(s.lo, Math.min(x, s.hi)), y: cy };
}

type Cards = { left: readonly Box[]; right: readonly Box[] };

/** The span of centres a label of half size `hw` x `hh` may take on the row
 *  centred at `cy`, see `clampLabel`. */
function rowSpan(cy: number, hw: number, hh: number, area: Box, cards: Cards, gap: number) {
  let lo = area.left + gap + hw;
  let hi = area.right - gap - hw;
  const inRow = (o: Box) =>
    o.right > o.left && o.bottom > o.top && o.bottom > cy - hh && o.top < cy + hh;
  for (const o of cards.right) if (inRow(o)) hi = Math.min(hi, o.left - gap - hw);
  for (const o of cards.left) if (inRow(o)) lo = Math.max(lo, o.right + gap + hw);
  return { lo, hi };
}

export interface LabelAt {
  /** where its dimension projected */
  x: number;
  y: number;
  hw: number;
  hh: number;
}

/** `clampLabel` for every label, then the clamped ones spread along the edge
 *  they were clamped to so no two of them overlap. A label pushed off the top
 *  or bottom slides along that row, one pushed off a side or against a card
 *  slides up or down. Each edge keeps its labels in the order their dimensions
 *  project, so they do not swap places while panning. Labels that did not need
 *  clamping stay where they are. */
export function layoutLabels(
  ls: readonly LabelAt[],
  area: Box,
  cards: Cards,
  gap: number,
): { x: number; y: number }[] {
  const out = ls.map((l) => clampLabel(l.x, l.y, l.hw, l.hh, area, cards, gap));
  const top: number[] = [];
  const bottom: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  const EPS = 0.5;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    const c = out[i]!;
    if (c.y > l.y + EPS) top.push(i);
    else if (c.y < l.y - EPS) bottom.push(i);
    else if (c.x > l.x + EPS) left.push(i);
    else if (c.x < l.x - EPS) right.push(i);
  }

  for (const row of [top, bottom]) {
    if (row.length < 2) continue;
    row.sort((a, b) => ls[a]!.x - ls[b]!.x || a - b);
    const span = row.map((i) => rowSpan(out[i]!.y, ls[i]!.hw, ls[i]!.hh, area, cards, gap));
    const pos = spread(
      row.map((i) => out[i]!.x),
      row.map((i) => ls[i]!.hw),
      span.map((s) => s.lo),
      span.map((s) => s.hi),
      gap,
    );
    row.forEach((i, k) => (out[i]!.x = pos[k]!));
  }

  const rows = [...top, ...bottom];
  for (const col of [left, right]) {
    if (!col.length) continue;
    col.sort((a, b) => ls[a]!.y - ls[b]!.y || a - b);
    // Keep clear of the rows too, where a corner has labels on both.
    const lo = col.map((i) => area.top + gap + ls[i]!.hh);
    const hi = col.map((i) => area.bottom - gap - ls[i]!.hh);
    let hit = false;
    col.forEach((i, k) => {
      const c = out[i]!;
      const l = ls[i]!;
      for (const r of rows) {
        const o = out[r]!;
        const lr = ls[r]!;
        if (Math.abs(o.x - c.x) >= l.hw + lr.hw + gap) continue;
        if (Math.abs(o.y - c.y) < l.hh + lr.hh + gap) hit = true;
        if (o.y < c.y) lo[k] = Math.max(lo[k]!, o.y + lr.hh + gap + l.hh);
        else hi[k] = Math.min(hi[k]!, o.y - lr.hh - gap - l.hh);
      }
    });
    if (col.length < 2 && !hit) continue;
    const pos = spread(
      col.map((i) => out[i]!.y),
      col.map((i) => ls[i]!.hh),
      lo,
      hi,
      gap,
    );
    col.forEach((i, k) => {
      if (pos[k] === out[i]!.y) return;
      const l = ls[i]!;
      out[i] = clampLabel(l.x, pos[k]!, l.hw, l.hh, area, cards, gap);
    });
  }
  return out;
}

/** Centres at `pos` (sorted, half sizes `half`) moved apart as little as it
 *  takes to leave `gap` between neighbours, each kept within `lo`..`hi` when
 *  there is room. Order is kept. */
function spread(pos: number[], half: number[], lo: number[], hi: number[], gap: number): number[] {
  const n = pos.length;
  const need = (k: number) => half[k - 1]! + gap + half[k]!;
  for (let k = 1; k < n; k++) pos[k] = Math.max(pos[k]!, pos[k - 1]! + need(k));
  for (let k = n - 1; k >= 0; k--) {
    pos[k] = Math.min(pos[k]!, hi[k]!);
    if (k < n - 1) pos[k] = Math.min(pos[k]!, pos[k + 1]! - need(k + 1));
  }
  for (let k = 0; k < n; k++) {
    pos[k] = Math.max(pos[k]!, lo[k]!);
    if (k > 0) pos[k] = Math.max(pos[k]!, pos[k - 1]! + need(k));
  }
  return pos;
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
