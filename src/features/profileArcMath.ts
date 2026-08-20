// The arithmetic behind the profile arc — the curved slider that sets a
// fillet's section shape, from a chamfer's flat chord through the circular
// fillet to a corner that is barely rounded at all.
//
// Split from the gizmo for the same reason edgeDragMath.ts is split from
// edgeFeatureTool.ts: the Three.js track, the knob and the hit test need a
// camera and a canvas, and none of this does. What lives here is the part that
// can be wrong in a way the user feels — where the knob sits for a given
// profile, what profile a grab position means, and how hard it is to land back
// on the circular fillet.

/** How far the slider travels either side of centre. The interval is OPEN: at
 *  exactly +1 there is no blend left to speak of and at exactly -1 the section's
 *  weight is zero, which is not a legal NURBS weight.
 *
 *  It stops well short of both, at 0.99, because the last thousandth is a shape
 *  nothing can draw: past it the viewport mesher loses the section and a mitred
 *  corner renders as a lens of surface standing proud of itself, while the
 *  kernel solid underneath is sound. conic_blend.PROFILE_LIMIT carries the
 *  measurements and the reasoning; the two must stay in step, and there is a
 *  test on each side that says so. */
export const PROFILE_LIMIT = 0.99;

/** Half-width of the detent at 0, in profile units.
 *
 *  0 is not just another value: it is the plain circular fillet, the only
 *  profile the kernel builds directly, and the one a user sliding around wants
 *  to be able to get back to exactly. Without a detent it is a measure-zero
 *  target on a continuous drag and you can only ever land near it — leaving
 *  documents full of 0.004-profile fillets that are needlessly reweighted
 *  surfaces rather than plain ones. */
export const PROFILE_DETENT = 0.02;

export function clampProfile(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(-PROFILE_LIMIT, Math.min(PROFILE_LIMIT, p));
}

/** Snap to the circular fillet inside the detent; clamp everywhere else. */
export function snapProfile(p: number): number {
  const v = clampProfile(p);
  return Math.abs(v) < PROFILE_DETENT ? 0 : v;
}

/** Is this profile the plain circular fillet — i.e. should the feature omit the
 *  field entirely rather than store a number that means "no change"? */
export function isPlainProfile(p: number | undefined): boolean {
  return p == null || Math.abs(p) < 1e-6;
}

/** Fraction 0..1 along the arc for a profile: 0 at the chamfer end, 0.5 at the
 *  circular fillet, 1 at the sharp end. Linear on purpose — the underlying
 *  weight is wildly non-linear (it runs to infinity at +1), and mapping the
 *  TRACK to the weight would bunch every useful shape into a sliver at one end.
 *  The user is choosing a look, not a weight. */
export function fractionFromProfile(p: number): number {
  return (clampProfile(p) / PROFILE_LIMIT + 1) / 2;
}

export function profileFromFraction(t: number): number {
  if (!Number.isFinite(t)) return 0;
  return clampProfile((Math.max(0, Math.min(1, t)) * 2 - 1) * PROFILE_LIMIT);
}

/** The readout beside the knob. Three decimals, and always signed, because the
 *  sign is the whole point — it says which side of the circular fillet you are
 *  on, and "0.815" alone does not. */
export function formatProfile(p: number): string {
  const v = clampProfile(p);
  if (v === 0) return "0";
  return `${v > 0 ? "+" : "-"}${Math.abs(v).toFixed(3)}`;
}

/** What the profile is doing, for the prompt line. */
export function describeProfile(p: number): string {
  const v = clampProfile(p);
  if (v === 0) return "circular";
  if (v > 0.9) return "nearly sharp";
  if (v > 0) return "fuller";
  if (v < -0.9) return "nearly a chamfer";
  return "flatter";
}
