// Where a pointer falls in a track of chips, the arithmetic behind dragging the
// history strip's rollback marker.
//
// Split from TimelineBar.vue because "which gap is the cursor in" is exactly the
// kind of thing that is silently wrong on the axis nobody tested: comparing x against a stacked column puts
// every chip's midpoint at the same coordinate, so the marker always lands in
// gap 0 and the model rolls back to nothing.
//
// Rects in, index out, no DOM. happy-dom implements no layout, so measurement
// code is normally e2e territory; this is the half of it that need not be.

/** The part of a DOMRect this needs. Structural, so a real DOMRect is one. */
export interface TrackRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Does this track run DOWN the page rather than across it?
 *
 *  Read off the rects rather than from the layout preference, so the answer
 *  cannot disagree with what is actually on screen during the frame an
 *  arrangement changes. Compares the span from the first chip to the last in
 *  each axis: a row spreads horizontally, a column vertically. Fewer than two
 *  chips has no direction, and answering "across" there costs nothing, with one
 *  chip both axes give the same gap. */
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
