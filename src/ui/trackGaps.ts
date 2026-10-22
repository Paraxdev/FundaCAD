// Which gap between history chips the pointer is in, for dragging the rollback marker. Rects in, index out, no DOM,
// since happy-dom has no layout and comparing x on a stacked column once put every drop in gap 0.

/** The part of a DOMRect this needs. Structural, so a real DOMRect is one. */
export interface TrackRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Read off the rects, not the layout preference, so it cannot disagree with the screen mid-change. Fewer than two
 *  chips has no direction and answers "across". */
export function trackIsStacked(rects: TrackRect[]): boolean {
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (!first || !last || first === last) return false;
  return last.top - first.top > last.left - first.left;
}

/** Which inter-chip gap (0..n) the pointer is in, measured along the track's own
 *  axis. n means "past the last chip", i.e. the end of the history. */
export function gapIndexIn(rects: TrackRect[], clientX: number, clientY: number): number {
  const stacked = trackIsStacked(rects);
  const along = stacked ? clientY : clientX;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!r) continue;
    const mid = stacked ? r.top + r.height / 2 : r.left + r.width / 2;
    if (along < mid) return i;
  }
  return rects.length;
}
