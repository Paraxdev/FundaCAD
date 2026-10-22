// Declines a click when the sketch plane is too edge-on, where a pixel becomes metres of plane. Measured on XY at a
// 130mm standoff, 90px above centre: facing 1.00 lands 13.8 mm out, 0.16 lands 257.8 mm, 0.000 lands 1.35 km.

/** |cos| between view direction and plane normal, 1 face-on. 0.1 is about 5.7 deg off edge-on, where a pixel is
 *  worth roughly ten times its square-on value; above it drawing stays awkward but honest. */
export const MIN_PLANE_FACING = 0.1;

type Vec3 = readonly [number, number, number];

function unitDot(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  if (!(la > 0) || !(lb > 0)) return 0; // a zero vector faces nothing
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
}

/** Unsigned, because drawing on the back of a plane is as legitimate as the front. */
export function planeFacing(viewDir: Vec3, normal: Vec3): number {
  return Math.abs(unitDot(viewDir, normal));
}

export function tooEdgeOn(viewDir: Vec3, normal: Vec3, min = MIN_PLANE_FACING): boolean {
  return planeFacing(viewDir, normal) < min;
}
