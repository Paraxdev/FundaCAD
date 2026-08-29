// How close the perspective camera may get, and where its near plane goes.
//
// The near plane was a fixed 0.1mm, and the closest the camera was allowed to
// sit to its pivot was 0.5mm — five times the near plane, so a deeper zoom
// could not push the surface behind near and clip the model away. That floor is
// what stops a zoom: measured on the running app, wheeling in past thirty
// notches parks at exactly 0.5mm and 5.4e-4 mm per pixel, and nothing gets any
// closer however long you keep wheeling.
//
// 0.5mm is not far enough in to look at what this app now makes. A texture
// facet, a 0.2mm fillet, the seam where two blends mitre: those are features
// half a millimetre across, and half a millimetre from the eye is where they
// START to fill the screen.
//
// So the near plane follows the camera in instead of standing still. It is a
// FRACTION of the pivot distance, clamped at both ends:
//
//   distance >= 2mm     near = 0.1     exactly today's number, so every
//                                      ordinary view is untouched by this file
//   distance = 0.5mm    near = 0.025
//   distance = 0.02mm   near = 0.001   the new floor, still 20x in front
//
// The ratio of distance to near therefore never falls below what it already was
// at the old floor (5); at the new floor it is 20, which is more headroom than
// the old arrangement ever had. Depth precision is a function of that ratio and
// of how far the FAR plane is, and far is left alone: at these distances the
// thing being inspected is millimetres away and resolves to nanometres, while
// what loses precision is the ground grid a hundred millimetres off, which is a
// flat plane with nothing to z-fight against.
//
// Orthographic is deliberately not touched. Its depth precision does not vary
// with zoom at all — the frustum depth is fixed — so there is no equivalent
// floor to lift, and shrinking its range to buy precision it has not been shown
// to need would clip the far corners of the ground grid for nothing.

/** Near plane for any ordinary view, and the value this file leaves in place
 *  whenever the camera is far enough out to use it. */
export const NEAR_AT_REST = 0.1;

/** Near sits this fraction of the way from the camera to its pivot. 1/20, so
 *  the surface being inspected has twenty times the near distance in front of
 *  it — four times the headroom the old fixed pair had at its floor. */
export const NEAR_FRACTION = 0.05;

/** Absolute floor on the near plane. Below a tenth of a micron the geometry is
 *  finer than the kernel's own tolerance and there is nothing left to look at. */
export const NEAR_FLOOR = 1e-4;

/** Closest the perspective camera may sit to its pivot, in mm — 25x closer than
 *  the 0.5mm it was.
 *
 *  Not taken further because the mesh is the next thing to give way. Vertex
 *  positions reach the GPU as float32, so a point 30mm from the origin is stored
 *  to about 2e-6 mm. At this distance one pixel spans 1.8e-5 mm, so that
 *  quantisation is a tenth of a pixel and invisible; another decade in and the
 *  user would be looking at the storage format rather than at their part. */
export const MIN_PERSP_DIST = 0.02;

/** Where to put the near plane with the camera this far from its pivot. */
export function perspNear(distance: number): number {
  if (!(distance > 0) || !Number.isFinite(distance)) return NEAR_AT_REST;
  return Math.min(NEAR_AT_REST, Math.max(NEAR_FLOOR, distance * NEAR_FRACTION));
}

// The FAR plane has to follow the camera OUT for the same reason near follows it
// in, and this end was the one that actually broke.
//
// The ground grid is adaptive: its cell tracks the zoom and it runs three
// viewport diagonals either side of the view centre (viewport/scene.ts), so
// zooming out to a 200mm cell already puts its far corner 8m away and a 500mm
// cell puts it 17.5m away. Far was a flat 10000mm. Past a ~200mm grid step the
// lattice therefore ran through the far plane and was cut off along a line
// across the middle of the view; a couple of notches further out and the whole
// grid — and any part sitting on it — was behind far and the viewport went
// black. Measured on the running app: step 200mm at distance 2813mm reaches
// 8000mm, step 1000mm at 13054mm reaches 37500mm.
//
// Tying far to the pivot distance fixes both ends of that at once, because the
// grid's own reach is proportional to the same distance (both come from
// mm-per-pixel), so one ratio covers every zoom.
//
// The cost is depth precision, which is a function of far/near, and near stops
// growing at 0.1mm — so past about 1.25m out the ratio does grow with the
// distance. That is the right trade here: the extra range is only ever handed
// out at zooms where the PART is a couple of pixels across and what needs
// resolving is the ground lattice, which writes no depth at all
// (scene.AdaptiveGrid sets depthWrite = false). Every view where depth
// precision is something a user can see keeps the same near/far pair it always
// had — see the first two tests in viewport/farPlane.test.ts.

/** Far plane for any ordinary view, and the floor this never goes below — a
 *  close-up must still be able to see the far side of a large part. */
export const FAR_AT_REST = 10000;

/** Far sits this many pivot distances out. The grid needs a shade under 4
 *  (37500/13054 at the extreme measured above); double it so an orbited,
 *  grazing view — where the far corner of the lattice is further away than the
 *  centre of it — has room too. */
export const FAR_FACTOR = 8;

/** Where to put the far plane with the camera this far from its pivot. */
export function perspFar(distance: number): number {
  if (!(distance > 0) || !Number.isFinite(distance)) return FAR_AT_REST;
  return Math.max(FAR_AT_REST, distance * FAR_FACTOR);
}

/** Half-depths of the orthographic frustum, from half the visible view height.
 *
 *  Orthographic was previously left alone on the grounds that its depth
 *  precision does not vary with zoom — true, and beside the point: its range was
 *  the same fixed ±10000, so a zoomed-out sketch clipped its own grid exactly
 *  the way perspective did. Depth is linear here, so the range can be generous:
 *  the lattice reaches about nine half-heights at the far end, and 30 leaves the
 *  same margin for a view looked at from an angle. */
export const ORTHO_DEPTH_FACTOR = 30;

export function orthoDepth(halfHeight: number): number {
  if (!(halfHeight > 0) || !Number.isFinite(halfHeight)) return FAR_AT_REST;
  return Math.max(FAR_AT_REST, halfHeight * ORTHO_DEPTH_FACTOR);
}
