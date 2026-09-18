// The arithmetic behind the fillet profile control (profileChip.ts): a section
// shape from a chamfer's flat chord through the circular fillet to a corner
// that is barely rounded at all, where a drag lands, and how hard it is to land
// back on the circular fillet.

/** How far the slider travels either side of centre. The interval is OPEN: at
 *  exactly +1 there is no blend left to speak of and at exactly -1 the section's
 *  weight is zero, which is not a legal NURBS weight.
 *
 *  It stops short of both, and not evenly. Towards the sharp end the kernel
 *  goes wrong first: past 0.95 the solid still checks valid but its volume and
 *  every boolean on it are wrong (a cut through a 0.99 fillet added material).
 *  The chamfer end stays sound to -0.99. blend_conic.hxx PROFILE_MAX and
 *  PROFILE_MIN carry the measurements; the two must stay in step. */
export const PROFILE_MAX = 0.95;
export const PROFILE_MIN = -0.99;

/** Half-width of the detent at 0, in profile units.
 *
 *  0 is not just another value: it is the plain circular fillet, the only
 *  profile the kernel builds directly, and the one a user sliding around wants
 *  to be able to get back to exactly. Without a detent it is a measure-zero
 *  target on a continuous drag and you can only ever land near it, leaving
 *  documents full of 0.004-profile fillets that are needlessly reweighted
 *  surfaces rather than plain ones. */
export const PROFILE_DETENT = 0.02;

export function clampProfile(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(PROFILE_MIN, Math.min(PROFILE_MAX, p));
}

/** Snap to the circular fillet inside the detent; clamp everywhere else. */
export function snapProfile(p: number): number {
  const v = clampProfile(p);
  return Math.abs(v) < PROFILE_DETENT ? 0 : v;
}

/** Is this profile the plain circular fillet, i.e. should the feature omit the
 *  field entirely rather than store a number that means "no change"? */
export function isPlainProfile(p: number | undefined): boolean {
  return p == null || Math.abs(p) < 1e-6;
}

/** Fraction 0..1 along the arc for a profile: 0 at the chamfer end, 0.5 at the
 *  circular fillet, 1 at the sharp end. Linear on purpose, the underlying
 *  weight is wildly non-linear (it runs to infinity at +1), and mapping the
 *  TRACK to the weight would bunch every useful shape into a sliver at one end.
 *  The user is choosing a look, not a weight. Each half is linear to its own
 *  limit, so the circular fillet stays at the middle of the track. */
export function fractionFromProfile(p: number): number {
  const v = clampProfile(p);
  return (v / (v < 0 ? -PROFILE_MIN : PROFILE_MAX) + 1) / 2;
}

export function profileFromFraction(t: number): number {
  if (!Number.isFinite(t)) return 0;
  const s = Math.max(0, Math.min(1, t)) * 2 - 1;
  return clampProfile(s * (s < 0 ? -PROFILE_MIN : PROFILE_MAX));
}

/** The readout beside the knob. Three decimals, and always signed, because the
 *  sign is the whole point, it says which side of the circular fillet you are
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

/** The kernel's middle-weight scale for a profile, blend_conic.hxx weight_scale. */
export function weightScale(p: number): number {
  const v = clampProfile(p);
  return v <= 0 ? 1 + v : 1 / (1 - v);
}

/** SVG path data for a right-angle corner blended at this profile, in a 24 unit
 *  box: the top face, the conic section, the side face. Sampled, because SVG has
 *  no rational curve and the weight is the whole point of the picture. */
export function sectionPath(p: number): string {
  const [x0, y0, cx, cy, x2, y2] = [4, 4, 20, 4, 20, 20];
  const w = Math.SQRT1_2 * weightScale(p);
  const pts: string[] = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const a = (1 - t) * (1 - t);
    const b = 2 * w * t * (1 - t);
    const c = t * t;
    const d = a + b + c;
    pts.push(`${((a * x0 + b * cx + c * x2) / d).toFixed(2)} ${((a * y0 + b * cy + c * y2) / d).toFixed(2)}`);
  }
  return `M1 4 L${pts.join(" L")} L20 23`;
}
