// The arithmetic behind the fillet profile control (profileChip.ts).

/** Open interval: at +1 no blend is left and at -1 the weight is zero. Past 0.95 the solid checks valid but its volume
 *  and booleans are wrong; the chamfer end holds to -0.99. Keep in step with blend_conic.hxx PROFILE_MAX and MIN. */
export const PROFILE_MAX = 0.95;
export const PROFILE_MIN = -0.99;

/** 0 is the plain circular fillet the kernel builds directly. Without a detent a drag only lands near it, leaving
 *  needlessly reweighted 0.004 profile fillets. */
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

/** The plain circular fillet, so the feature omits the field rather than store a no-op number. */
export function isPlainProfile(p: number | undefined): boolean {
  return p == null || Math.abs(p) < 1e-6;
}

/** 0 chamfer, 0.5 circular, 1 sharp. Linear per half on purpose: the weight runs to infinity at +1, and mapping it
 *  would bunch every useful shape into one end. */
export function fractionFromProfile(p: number): number {
  const v = clampProfile(p);
  return (v / (v < 0 ? -PROFILE_MIN : PROFILE_MAX) + 1) / 2;
}

export function profileFromFraction(t: number): number {
  if (!Number.isFinite(t)) return 0;
  const s = Math.max(0, Math.min(1, t)) * 2 - 1;
  return clampProfile(s * (s < 0 ? -PROFILE_MIN : PROFILE_MAX));
}

/** Always signed: the sign says which side of the circular fillet you are on. */
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

/** In a 24 unit box: top face, conic section, side face. Sampled, since SVG has no rational curve. */
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
