// Where the feature-values popover sits when the history is the bottom strip.
//
// The values a feature carries are edited under its own entry in the history —
// that is the whole point of putting them there, since the entry already names
// the operation being changed. In the side arrangement there is room to open
// them in the flow, indented under the chip. The bottom strip is 52px of chrome
// with a horizontal scroller inside it, so there the panel has to float ABOVE
// the strip, which means fixed coordinates, which means arithmetic worth
// separating from the component that measures it.
//
// Fixed rather than absolute is forced: #timeline is `overflow: hidden` and
// .timeline-scroll scrolls inside it, so anything positioned within the strip
// is clipped at its top edge. The panel is teleported to the body instead.
//
// The panel used to FOLLOW its chip along the strip, on the argument that the
// chip's column is what tied the values to the operation they belong to. That
// argument does not survive a long history: the strip scrolls, so the column
// moves under a panel that is being typed into, two chips a few pixels apart
// throw the panel across the window, and near the left edge it lands over the
// view controls and has to be lifted off them. The panel keeps ONE berth now
// and only its contents change — which is the same thing every docked inspector
// in every other tool does, and for the same reason.

export interface Rect {
  left: number;
  right: number;
  top: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** `left` and `bottom` for a `position: fixed` panel parked against the right
 *  edge of the window, resting `gap` px above `strip`.
 *
 *  Right rather than left because the left is spoken for twice over: the
 *  browser tree runs down it, and the view-control pill sits at the bottom of
 *  the viewport there. The right edge is empty in every arrangement the layout
 *  offers, so the panel can hold one place without ever being lifted, nudged or
 *  clamped in normal use.
 *
 *  `bottom` is measured from the bottom of the window because that is the axis
 *  the panel grows along: it is anchored to the strip and gets taller upward as
 *  a feature gains fields, and a `top` would have to be recomputed for every
 *  height change.
 *
 *  `over` is a rect the panel must not cover, given as the union of whatever
 *  furniture floats above the strip. It cannot fire at any ordinary window size
 *  now that the berth is on the far side from the pill — but a window narrow
 *  enough puts the two back in the same column, and the panel would land across
 *  ISO / Top / Front again. Horizontal overlap is the test, so furniture the
 *  panel is already clear of costs it no height. */
export function anchorPanel(
  strip: Rect,
  view: Viewport,
  panelWidth: number,
  gap = 8,
  margin = 8,
  over?: Rect | null,
): { left: number; bottom: number } {
  const widest = Math.max(0, view.width - margin * 2);
  const w = Math.min(panelWidth, widest);
  const left = Math.max(margin, view.width - margin - w);
  let top = strip.top;
  // Strictly-less comparisons on both sides: two rects that merely touch at an
  // edge are not overlapping, and treating them as though they were would lift
  // the panel over a pill it was already clear of.
  if (over && left < over.right && left + w > over.left && over.top < top) top = over.top;
  return { left, bottom: Math.max(margin, view.height - top + gap) };
}
