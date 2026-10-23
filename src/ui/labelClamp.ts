// Keeps sketch dimension labels readable: the viewport runs full bleed under the floating columns, so a label near
// the left edge landed under the Items card (PH-3).

import type { Box } from "./promptPlacement";

/** Where a label of half size `hw` x `hh` projected to (`x`, `y`) is drawn: inside `area`, `gap` clear of the cards
 *  in its row. When the free span is too narrow, the left card wins, as in the prompt. */
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

/** The free span of label edges on the row centred at `cy`, half height `hh`:
 *  inside `area` and `gap` clear of the cards in that row. */
function rowFree(cy: number, hh: number, area: Box, cards: Cards, gap: number) {
  let L = area.left + gap;
  let R = area.right - gap;
  const inRow = (o: Box) => o.right > o.left && o.bottom > o.top && o.bottom > cy - hh && o.top < cy + hh;
  for (const o of cards.right) if (inRow(o)) R = Math.min(R, o.left - gap);
  for (const o of cards.left) if (inRow(o)) L = Math.max(L, o.right + gap);
  return { L, R };
}

function rowSpan(cy: number, hw: number, hh: number, area: Box, cards: Cards, gap: number) {
  const { L, R } = rowFree(cy, hh, area, cards, gap);
  return { lo: L + hw, hi: R - hw };
}

export interface LabelAt {
  /** where its dimension projected */
  x: number;
  y: number;
  hw: number;
  hh: number;
}

export type Edge = "top" | "bottom" | "left" | "right";

/** Which edge a clamped label is on, which line of it counting inward, and
 *  when it joined, kept from frame to frame by label index. */
export interface Held {
  edge: Edge;
  line: number;
  since: number;
}

/** How far past its spot a label is clamped before it joins an edge, and how
 *  far back on screen it has to come before it leaves again. */
const JOIN = 1;
const LEAVE = 12;
let joins = 0;

/** Clamped labels line up along their edge without overlap, wrapping inward, in projection order so panning keeps
 *  them in place. `held` keeps each label's edge and line from the last frame so newcomers do not reshuffle them. */
export function layoutLabels(
  ls: readonly LabelAt[],
  area: Box,
  cards: Cards,
  gap: number,
  held: Map<number, Held> = new Map(),
): { x: number; y: number }[] {
  const out = ls.map((l) => clampLabel(l.x, l.y, l.hw, l.hh, area, cards, gap));
  // A column keeps clear of every card on its side, so it stays straight
  // rather than following the rail's buttons in and out as it slides.
  const cardL = Math.max(area.left + gap, ...cards.left.map((o) => o.right + gap));
  const cardR = Math.min(area.right - gap, ...cards.right.map((o) => o.left - gap));
  const near: Record<Edge, (l: LabelAt) => boolean> = {
    top: (l) => clampLabel(l.x, l.y - LEAVE, l.hw, l.hh, area, cards, gap).y > l.y - LEAVE + JOIN,
    bottom: (l) => clampLabel(l.x, l.y + LEAVE, l.hw, l.hh, area, cards, gap).y < l.y + LEAVE - JOIN,
    left: (l) => l.x - l.hw < cardL + LEAVE,
    right: (l) => l.x + l.hw > cardR - LEAVE,
  };
  const groups: Record<Edge, number[]> = { top: [], bottom: [], left: [], right: [] };
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    const c = out[i]!;
    const off: Record<Edge, boolean> = {
      top: c.y > l.y + JOIN,
      bottom: c.y < l.y - JOIN,
      left: c.x > l.x + JOIN,
      right: c.x < l.x - JOIN,
    };
    const h = held.get(i);
    let e: Edge | undefined;
    if (h && (off[h.edge] || near[h.edge](l))) e = h.edge;
    else e = off.top ? "top" : off.bottom ? "bottom" : off.left ? "left" : off.right ? "right" : undefined;
    if (!e) {
      held.delete(i);
      continue;
    }
    if (!h || h.edge !== e) held.set(i, { edge: e, line: 0, since: joins++ });
    groups[e].push(i);
  }
  const byRank = (a: number, b: number) => {
    const ha = held.get(a)!;
    const hb = held.get(b)!;
    return ha.line - hb.line || ha.since - hb.since;
  };

  const placed: number[] = [];
  for (const e of ["top", "bottom"] as const) {
    const pool = groups[e].sort(byRank);
    if (!pool.length) continue;
    const H = Math.max(...pool.map((i) => ls[i]!.hh));
    const step = e === "top" ? 2 * H + gap : -(2 * H + gap);
    let y = e === "top" ? area.top + gap + H : area.bottom - gap - H;
    for (let j = 0; pool.length; j++, y += step) {
      const last = e === "top" ? y + step + H > area.bottom - gap : y + step - H < area.top + gap;
      const { L, R } = rowFree(y, H, area, cards, gap);
      const take = fill(pool, (i) => 2 * ls[i]!.hw, R - L, gap, last);
      if (!take.length) continue;
      take.sort((a, b) => ls[a]!.x - ls[b]!.x || a - b);
      const half = take.map((i) => ls[i]!.hw);
      const pos = spread(
        take.map((i) => ls[i]!.x),
        half,
        half.map((h) => L + h),
        half.map((h) => R - h),
        gap,
      );
      take.forEach((i, n) => {
        out[i] = { x: pos[n]!, y };
        held.get(i)!.line = j;
      });
      placed.push(...take);
    }
  }

  for (const e of ["left", "right"] as const) {
    const pool = groups[e].sort(byRank);
    if (!pool.length) continue;
    const W = 2 * Math.max(...pool.map((i) => ls[i]!.hw));
    // the outer edge of this column's labels
    let wall = e === "left" ? cardL : cardR;
    for (let j = 0; pool.length; j++) {
      const x0 = e === "left" ? wall : wall - W;
      const x1 = e === "left" ? wall + W : wall;
      const last = e === "left" ? x1 + gap + W > area.right - gap : x0 - gap - W < area.left + gap;
      let T = area.top + gap;
      let B = area.bottom - gap;
      for (const r of placed) {
        const o = out[r]!;
        const lr = ls[r]!;
        if (o.x + lr.hw <= x0 - gap || o.x - lr.hw >= x1 + gap) continue;
        if (o.y < (area.top + area.bottom) / 2) T = Math.max(T, o.y + lr.hh + gap);
        else B = Math.min(B, o.y - lr.hh - gap);
      }
      const take = fill(pool, (i) => 2 * ls[i]!.hh, B - T, gap, last);
      if (!take.length) {
        wall = e === "left" ? x1 + gap : x0 - gap;
        continue;
      }
      take.sort((a, b) => ls[a]!.y - ls[b]!.y || a - b);
      const half = take.map((i) => ls[i]!.hh);
      const pos = spread(
        take.map((i) => ls[i]!.y),
        half,
        half.map((h) => T + h),
        half.map((h) => B - h),
        gap,
      );
      let next = wall;
      take.forEach((i, n) => {
        const hw = ls[i]!.hw;
        const x = e === "left" ? wall + hw : wall - hw;
        out[i] = { x, y: pos[n]! };
        held.get(i)!.line = j;
        next = e === "left" ? Math.max(next, x + hw + gap) : Math.min(next, x - hw - gap);
      });
      wall = next;
    }
  }
  return out;
}

/** Takes from the front of `pool` what fits a line `room` long, each `size`,
 *  `gap` apart. The last line takes the rest whether it fits or not. */
function fill(pool: number[], size: (i: number) => number, room: number, gap: number, last: boolean): number[] {
  if (last) return pool.splice(0);
  let used = -gap;
  let n = 0;
  while (n < pool.length) {
    const s = size(pool[n]!);
    if (used + gap + s > room) break;
    used += gap + s;
    n++;
  }
  return pool.splice(0, n);
}

/** Moves sorted centres apart as little as it takes to leave `gap` between neighbours, each within `lo`..`hi`, order
 *  kept. They overlap only when the line is too short. */
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
  for (let k = 0; k < n; k++) pos[k] = Math.min(pos[k]!, hi[k]!);
  return pos;
}

/** The leader from a moved label at `c` back to `p`, starting on the label border facing `p`. Null when the label is
 *  on or near its spot. */
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
