/** When the sketch plane has turned too far edge-on to place a point on.
 *
 *  Orbit up over the top of a sketch and the plane rolls away until you are
 *  looking along it. The screen-to-plane ray still meets it, and the answer is
 *  still exactly right — but a plane seen nearly edge-on turns a pixel of cursor
 *  travel into metres of plane. Measured on the XY plane at a 130mm standoff,
 *  clicking 90px above the view centre:
 *
 *    facing 1.00 (square on)   lands  13.8 mm out
 *    facing 0.24               lands  97.5 mm out
 *    facing 0.16               lands 257.8 mm out
 *    facing 0.001              lands  12.1 m out
 *    facing 0.000 (the clamp)  lands   1.35 KM out
 *
 *  which is the reported "it goes off to the side": the click is honoured, at a
 *  point nowhere near where it was aimed and usually off the screen entirely.
 *  Past the clamp the ray misses the plane outright and the click does nothing,
 *  with nothing said either way.
 *
 *  So there is a point below which a click on this plane cannot mean what it
 *  looks like it means, and the honest answer is to decline it and say why
 *  rather than to place a point a kilometre away.
 */

/** How square-on the plane has to stay: |cos| between the view direction and
 *  the plane normal, so 1 is face-on and 0 is exactly edge-on.
 *
 *  0.1 is about 5.7 degrees off edge-on, where one pixel is already worth
 *  roughly ten times what it is worth square-on. Below that the plane is a line
 *  on screen and there is nothing left to aim at; above it, drawing stays
 *  awkward but honest, and the choice of where to stop drawing is the user's. */
export const MIN_PLANE_FACING = 0.1;

type Vec3 = readonly [number, number, number];

function unitDot(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  if (!(la > 0) || !(lb > 0)) return 0; // a zero vector faces nothing
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
}

/** How square-on the plane is to the camera: 1 face-on, 0 edge-on. Unsigned,
 *  because drawing on the back of a plane is as legitimate as the front. */
export function planeFacing(viewDir: Vec3, normal: Vec3): number {
  return Math.abs(unitDot(viewDir, normal));
}

/** Is the plane too edge-on to place a point on? */
export function tooEdgeOn(viewDir: Vec3, normal: Vec3, min = MIN_PLANE_FACING): boolean {
  return planeFacing(viewDir, normal) < min;
}
