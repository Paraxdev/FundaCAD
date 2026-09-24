// Where the viewport prompt may sit: the span along its row that no floating
// card covers. The viewport runs full bleed under the left and right columns,
// so centring on the viewport alone slid the prompt under the tool rail as soon
// as the Render panel narrowed the view.

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

/** Insets from `area`'s sides that keep a row spanning `band` clear of the
 *  left and right columns' cards, `gap` from each. The side comes from the
 *  column, not from where a card lies: in a narrow view the rail's labels reach
 *  past the middle. A card that misses the band vertically is ignored, so a
 *  column that ends above the row does not squeeze it. When less than
 *  `minWidth` would be left, the right inset gives way first, then the left. */
export function promptInsets(
  area: Box,
  band: { top: number; bottom: number },
  cards: { left: readonly Box[]; right: readonly Box[] },
  gap: number,
  minWidth: number,
): Insets {
  const inRow = (o: Box) =>
    o.right > o.left && o.bottom > o.top && o.bottom > band.top && o.top < band.bottom;
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
