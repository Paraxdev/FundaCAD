// How close to an edge a click must be for the edge to win. The band is a fraction of the face's short screen side,
// capped at EDGE_NEAR_PX, so a small face at a shallow angle keeps an interior (a 3mm face at 60 deg is 11 x 5 px).

/** How far from an edge, in screen px, the edge tools still take it: the
 *  grab radius of every edge pick, whatever the zoom. */
export const EDGE_GRAB_PX = 13;

/** Screen-space radius, in px, within which an edge is preferred over a face. The band
 *  never exceeds this, so it is still the answer for any ordinary face. */
export const EDGE_NEAR_PX = 3;

/** How much of a small face's short side the band may eat. */
export const BAND_FRACTION = 0.2;

/** The band never closes completely, or an edge-on face would make its own
 *  edges unpickable. */
export const BAND_MIN_PX = 0.75;

/** Null (no face, or one not measured) gives the plain EDGE_NEAR_PX. */
export function edgeBandPx(minExtentPx: number | null): number {
  if (minExtentPx == null || !Number.isFinite(minExtentPx)) return EDGE_NEAR_PX;
  return Math.max(BAND_MIN_PX, Math.min(EDGE_NEAR_PX, minExtentPx * BAND_FRACTION));
}

// A vertical edge foreshortens toward a point as the view nears edge on, and its own short projection makes it hard
// to click, so a short edge gets a wider band.

/** An edge projecting shorter than this on screen counts as foreshortened. */
export const EDGE_SHORT_MAX_PX = 15;

/** The most a foreshortened edge's band may grow by, at (or near) zero length. */
export const EDGE_SHORT_BOOST_PX = 6;

/** Added to edgeBandPx's result, 0 from EDGE_SHORT_MAX_PX up or when not measured. */
export function shortEdgeBoostPx(edgeLengthPx: number | null): number {
  if (edgeLengthPx == null || !Number.isFinite(edgeLengthPx) || edgeLengthPx >= EDGE_SHORT_MAX_PX) return 0;
  const t = 1 - Math.max(0, edgeLengthPx) / EDGE_SHORT_MAX_PX;
  return t * EDGE_SHORT_BOOST_PX;
}

/** Above this on-screen extent the band is capped, so measuring more precisely
 *  cannot change the answer. Lets the walk below stop early. */
export const BAND_CAP_EXTENT_PX = EDGE_NEAR_PX / BAND_FRACTION;

/** The smaller side of a screen box, null when empty. Axis aligned, so it over-measures a diagonal sliver such as an
 *  isometric chamfer strip; the fix would be a rotating calipers pass over the projected hull. */
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

  /** The max of width and height so far, Infinity before anything is added. */
  get max(): number {
    if (this.minX > this.maxX) return Infinity;
    return Math.max(this.maxX - this.minX, this.maxY - this.minY);
  }

  get measured(): boolean {
    return this.minX <= this.maxX;
  }
}

/** Spread across the range, not a prefix: tessellator order is spatially coherent, so a prefix measures a couple of
 *  rows of a big face as a sliver. Spread samples also reach the BAND_CAP_EXTENT_PX early exit within a few. */
export function sampleIndices(total: number, budget: number): number[] {
  if (total <= 0 || budget <= 0) return [];
  if (total <= budget) return Array.from({ length: total }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < budget; k++) out.push(Math.floor((k * total) / budget));
  return out;
}

// A smooth (tangent) edge is drawn faint and a click beside it usually means a face or a nearby sharp edge, so it ranks
// behind sharp edges and beats the face under the pointer only on its drawn line.

/** A smooth edge ranks as if it were this much further from the pointer, so a
 *  sharp edge up to this much further away is preferred over it. */
export const SMOOTH_EDGE_PENALTY_PX = 6;

/** Over a face, a smooth edge is preferred only this close: about the half
 *  width of its drawn line, and no short-edge boost. */
export const SMOOTH_EDGE_BAND_PX = 1;

/** The distance an edge candidate is ranked by, nearest first. */
export function edgeRankPx(screenDist: number, smooth: boolean): number {
  return screenDist + (smooth ? SMOOTH_EDGE_PENALTY_PX : 0);
}

/** How close the pointer must be for this edge to beat the face under it. */
export function edgeBandForPx(faceBandPx: number, shortBoostPx: number, smooth: boolean): number {
  return smooth ? Math.min(faceBandPx, SMOOTH_EDGE_BAND_PX) : faceBandPx + shortBoostPx;
}

export interface BandCandidate {
  /** distance from the pointer, in screen px */
  screenDist: number;
  /** round the back of the body (picking.occludedEdge). A sight ray through
   *  every body, so asked last and only of a candidate that could win. */
  occluded: () => boolean;
  /** edgeBandForPx for this edge, asked only over a face */
  bandPx: () => number;
}

/** The first candidate in rank order that is not occluded and lies within its band, null for the face. With no face
 *  under the pointer every candidate is in reach. */
export function preferredEdge(cands: readonly BandCandidate[], overFace: boolean): number | null {
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]!;
    if (overFace && c.screenDist > c.bandPx()) continue;
    if (!c.occluded()) return i;
  }
  return null;
}
