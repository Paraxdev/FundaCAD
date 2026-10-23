// The span of the prompt's row no floating card covers: the viewport runs full bleed, so centring alone slid the
// prompt under the tool rail once the Render panel narrowed the view.

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Insets {
  left: number;
  right: number;
}

/** The side comes from the column, not the card position, since in a narrow view the rail labels reach past the
 *  middle. Cards missing the band are ignored. Below `minWidth` the right inset gives way first, then the left. */
export function promptInsets(
  area: Box,
  band: { top: number; bottom: number },
  cards: { left: readonly Box[]; right: readonly Box[] },
  gap: number,
  minWidth: number,
): Insets {
  const inRow = (o: Box) => o.right > o.left && o.bottom > o.top && o.bottom > band.top && o.top < band.bottom;
  let left = gap;
  let right = gap;
  for (const o of cards.left) if (inRow(o)) left = Math.max(left, o.right - area.left + gap);
  for (const o of cards.right) if (inRow(o)) right = Math.max(right, area.right - o.left + gap);
  const width = area.right - area.left;
  let short = minWidth - (width - left - right);
  if (short > 0) {
    const give = Math.min(short, Math.max(0, right - gap));
    right -= give;
    short -= give;
    if (short > 0) left = Math.max(gap, left - short);
  }
  return { left: Math.round(left), right: Math.round(right) };
}

export interface Row extends Insets {
  top: number;
}

/** The highest row at or below `top` where a box of `size` fits between the columns' cards, `gap` from each, with
 *  its top and its insets from `area`'s sides. Rows start at `top` and under each card. Null when none fits. */
export function clearRow(
  area: Box,
  size: { width: number; height: number },
  top: number,
  cards: { left: readonly Box[]; right: readonly Box[] },
  gap: number,
): Row | null {
  const under = [...cards.left, ...cards.right].map((o) => o.bottom + gap).filter((t) => t > top);
  for (const t of [top, ...under].sort((a, b) => a - b)) {
    if (t + size.height > area.bottom - gap) break;
    const { left, right } = promptInsets(area, { top: t, bottom: t + size.height }, cards, gap, 0);
    if (area.right - area.left - left - right >= size.width) return { top: t, left, right };
  }
  return null;
}

// The rail's buttons rather than the rail: its box runs the full height at the
// width of its widest label, which sits at the top.
export const LEFT_CARDS =
  "#float-layer .float-left-stack > *, #float-layer .tool-rail .rail-btn, #float-layer .tool-rail .rail-group";
export const RIGHT_CARDS = "#float-layer .float-right > *";

const rects = (sel: string): Box[] => [...document.querySelectorAll(sel)].map((o) => o.getBoundingClientRect());

/** The part of `area` a row spanning `band` can use without sliding under a card. */
export function clearOfCards(area: Box, band: { top: number; bottom: number }, gap: number, minWidth: number): Box {
  const { left, right } = promptInsets(
    area,
    band,
    { left: rects(LEFT_CARDS), right: rects(RIGHT_CARDS) },
    gap,
    minWidth,
  );
  return { left: area.left + left, right: area.right - right, top: area.top, bottom: area.bottom };
}
