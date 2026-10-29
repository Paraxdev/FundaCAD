// The face, edge and sketch pick colours from the theme accent. A flat accent washes out when it sits close to the
// body's own lightness, so the rule keeps the accent's hue, lifts its chroma and moves its lightness away from the
// colour under the pick until what is seen, the pick laid over the body at its opacity, clears a contrast floor.

export type PickKind = "hover" | "select";
export type PickPart = "face" | "edge";

/** The opacity each pick is seen at over the body. A face is also tinted in its own shading, the overlay alone is the
 *  worst case (Path traced, glass). An edge is painted opaque in `composite(body, pick, alpha)`. */
export const PICK_ALPHA: Record<PickPart, Record<PickKind, number>> = {
  face: { hover: 0.4, select: 0.7 },
  edge: { hover: 0.6, select: 1 },
};

/** WCAG contrast ratio of the seen pick against the body. */
export const MIN_CONTRAST: Record<PickKind, number> = { hover: 1.6, select: 3 };

/** Below this OKLCH chroma the accent is a grey and stays one, there is no hue to lift. */
const NEUTRAL_CHROMA = 0.02;
const MIN_CHROMA = 0.12;

const channels = (hex: number): [number, number, number] => [
  ((hex >> 16) & 255) / 255,
  ((hex >> 8) & 255) / 255,
  (hex & 255) / 255,
];
const toHex = (c: readonly number[]): number =>
  c.reduce((h, v) => (h << 8) | Math.round(Math.min(1, Math.max(0, v)) * 255), 0);
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export function luminance(hex: number): number {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `pick` over `under` at `alpha`, blended on the encoded values as the canvas does. */
export function composite(under: number, pick: number, alpha: number): number {
  const u = channels(under);
  const p = channels(pick);
  return toHex(u.map((v, i) => v + (p[i]! - v) * alpha));
}

/** [L 0..1, C, h degrees] */
export function oklch(hex: number): [number, number, number] {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return [L, Math.hypot(A, B), h < 0 ? h + 360 : h];
}

function linearFromOklch(L: number, C: number, h: number): [number, number, number] {
  const A = C * Math.cos((h * Math.PI) / 180);
  const B = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Chroma is given up, never lightness or hue, to land inside sRGB. */
function fromOklch(L: number, C: number, h: number): number {
  const inside = (c: number) => linearFromOklch(L, c, h).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let c = C;
  if (!inside(c)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inside(mid)) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  return toHex(linearFromOklch(L, c, h).map((v) => toSrgb(Math.min(1, Math.max(0, v)))));
}

/** The pick colour for `accent` over `under`: the face's own colour, the ground under a sketch, or for an edge its body
 *  and the ground its silhouette is seen against. Against several it is the weakest that has to clear the floor. */
export function pickColor(
  accent: number,
  under: number | readonly number[],
  kind: PickKind,
  part: PickPart = "face",
): number {
  const alpha = PICK_ALPHA[part][kind];
  const unders = typeof under === "number" ? [under] : under;
  const floor = MIN_CONTRAST[kind];
  const seen = (c: number) => Math.min(...unders.map((u) => contrastRatio(composite(u, c, alpha), u)));
  const [La, Ca, h] = oklch(accent);
  const C = Ca < NEUTRAL_CHROMA ? Ca : Math.max(Ca, MIN_CHROMA);
  if (C === Ca && seen(accent) >= floor) return accent;
  let best = fromOklch(La, C, h);
  let bestSeen = seen(best);
  if (bestSeen >= floor) return best;
  // The smallest lightness step that clears the floor, trying the darker and the lighter side in turn.
  for (let step = 0.01; step <= 1; step += 0.01) {
    for (const L of [La - step, La + step]) {
      if (L < 0 || L > 1) continue;
      const c = fromOklch(L, C, h);
      const s = seen(c);
      if (s >= floor) return c;
      if (s > bestSeen) {
        best = c;
        bestSeen = s;
      }
    }
  }
  return best;
}
