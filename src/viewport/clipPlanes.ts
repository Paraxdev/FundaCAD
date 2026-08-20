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
