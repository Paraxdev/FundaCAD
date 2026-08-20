// How close to an edge you have to be before the edge takes the click.
//
// The gate used to be a fixed 3px halo inside every face border, so how much of
// a face survived it depended entirely on how big that face happened to be on
// screen. A small face at a shallow angle has no interior left at all:
//
//   at 45deg fov, 1440x900, a face 300mm away (one pixel is 0.276mm)
//
//     3mm  head-on     11 x 11 px    a 3px halo leaves 20% of it
//     3mm  at 60 deg   11 x  5 px    leaves NOTHING, and that is the complaint
//     6mm  at 60 deg   22 x 11 px    32%
//     24mm at 60 deg   87 x 43 px    80%
//
// So the band is a FRACTION of the face rather than a fixed number of pixels,
// capped so that nothing which is comfortably clickable today moves:
//
//     band = clamp(minScreenExtentPx * BAND_FRACTION, BAND_MIN_PX, EDGE_NEAR_PX)
//
// The cap is the safety property. At a minimum screen extent of 15px or more
// (EDGE_NEAR_PX / BAND_FRACTION) the band is 3px again, so every face that picks
// well now picks identically, and edges keep winning everywhere they win now.
// It is the MINIMUM dimension that decides, not the area or the diagonal: the
// 6mm row above is 22px along its long side and is still changed, because its
// short side is 11px and that sliver is the whole problem.
//
// The floor stops the band vanishing entirely on a face reduced to a line, where
// an edge must still be reachable.
//
// KNOWN LIMIT, measured rather than assumed: the extent is an AXIS-ALIGNED
// screen box, so it over-measures a sliver lying diagonally on screen. A
// chamfer strip seen in an isometric view is exactly that, and the band stays
// at EDGE_NEAR_PX for it. Front-on, where the box is honest, the same strips at
// 5.1px go from 57.8% to 67.4% of their pixels resolving as the face, while a
// 118px face stays put (95.9% to 96.7%, the same 44,625 pixels). Fixing the
// diagonal case needs the minimum width over all directions rather than over
// the two screen axes, which is a rotating-calipers pass over the projected
// hull; worth doing, and worth doing only with that measurement in hand.

/** Screen-space radius, in px, within which an edge beats a face. The band
 *  never exceeds this, so it is still the answer for any ordinary face. */
export const EDGE_NEAR_PX = 3;

/** How much of a small face's short side the band may eat. */
export const BAND_FRACTION = 0.2;

/** The band never closes completely, or an edge-on face would make its own
 *  edges unpickable. */
export const BAND_MIN_PX = 0.75;

/** The edge-priority band for a face of this minimum on-screen extent.
 *
 *  `minExtentPx` of null (no face under the cursor, or a face whose extent
 *  could not be measured) gives the plain constant, which is the behaviour
 *  everything had before the face was measured at all.
 */
export function edgeBandPx(minExtentPx: number | null): number {
  if (minExtentPx == null || !Number.isFinite(minExtentPx)) return EDGE_NEAR_PX;
  return Math.max(BAND_MIN_PX, Math.min(EDGE_NEAR_PX, minExtentPx * BAND_FRACTION));
}

/** Above this on-screen extent the band is capped, so measuring more precisely
 *  cannot change the answer. Lets the walk below stop early. */
export const BAND_CAP_EXTENT_PX = EDGE_NEAR_PX / BAND_FRACTION;

/** The smaller side of a screen-space bounding box, or null if nothing was
 *  added to it. Separated so the walk can be tested without a renderer. */
export class ScreenExtent {
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  add(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }

  /** The min of width and height so far. Infinity before anything is added, so
   *  a caller polling it for an early exit never exits on an empty box. */
  get min(): number {
    if (this.minX > this.maxX) return Infinity;
    return Math.min(this.maxX - this.minX, this.maxY - this.minY);
  }

  get measured(): boolean {
    return this.minX <= this.maxX;
  }
}

/** Indices into `total` items, spread ACROSS the range rather than taken from
 *  the front.
 *
 *  This is the whole difference between measuring a face and measuring a corner
 *  of one. Triangle order out of a tessellator is spatially coherent, so the
 *  first N triangles of a large face are a couple of ROWS of it: a prefix walk
 *  under-estimates by the entire unwalked remainder, and reports a large face as
 *  a sliver. A spread sample is wrong only by the geometry lying between two
 *  neighbouring samples.
 *
 *  It is also cheaper rather than dearer. Consecutive samples are far apart on a
 *  big face, so an early exit on BAND_CAP_EXTENT_PX fires within a few of them,
 *  where a prefix walk runs its whole budget without ever exiting.
 */
export function sampleIndices(total: number, budget: number): number[] {
  if (total <= 0 || budget <= 0) return [];
  if (total <= budget) return Array.from({ length: total }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < budget; k++) out.push(Math.floor((k * total) / budget));
  return out;
}
