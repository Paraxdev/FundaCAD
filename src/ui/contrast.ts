/** WCAG contrast maths over the palette colour forms theme.ts accepts: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(). */

export type Rgba = [number, number, number, number];

export function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((h) => h + h).join("") : hex;
    const n = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v)?.[1];
  if (fn) {
    const parts = fn.split(/[\s,/]+/).filter(Boolean);
    const num = (s: string | undefined, scale: number) =>
      s === undefined ? NaN : s.endsWith("%") ? (Number(s.slice(0, -1)) / 100) * scale : Number(s);
    const out: Rgba = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), parts[3] ? num(parts[3], 1) : 1];
    if (parts.length >= 3 && out.every(Number.isFinite)) return out;
  }
  throw new Error(`not a colour: ${value}`);
}

/** `top` composited over an opaque `under`. */
export function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
}

/** color-mix(in srgb, a pct, b) for an opaque `b`. */
export function mix(a: Rgba, pct: number, b: Rgba): Rgba {
  return over([a[0], a[1], a[2], pct * a[3]], b);
}

export function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const [a, b] = [luminance(over(fg, bg)), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** CIE L*, 0 to 100. */
export function lightness(c: Rgba): number {
  const y = luminance(c);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

export interface PairResult {
  what: string;
  ratio: number;
  min: number;
}

const TEXT_TOKENS = ["--text", "--text-dim", "--text-mute"];
const TEXT_SURFACES = ["--panel", "--panel-2", "--raised", "--raised-2"];
const LINE_SURFACES = ["--panel", "--raised"];

/** The rail pill and readout glass over the bare scene, as _tokens.scss builds --float-bg for each mode. */
export function glassFill(p: Record<string, string>, mode: "dark" | "light"): Rgba {
  const c = (name: string) => parseColor(p[name] ?? `missing ${name}`);
  if (mode === "light") return mix(mix(c("--raised"), 0.7, c("--bg")), 0.97, c("--viewport-bg"));
  return mix(c("--panel"), 0.72, c("--viewport-bg"));
}

/** Every text and line pair a palette must pass, worst first. `p` is a whole palette, Noir defaults filled in. */
export function paletteContrast(p: Record<string, string>, mode: "dark" | "light"): PairResult[] {
  const c = (name: string) => parseColor(p[name] ?? `missing ${name}`);
  const out: PairResult[] = [];
  const add = (what: string, fg: Rgba, bg: Rgba, min: number) =>
    out.push({ what, ratio: Math.round(contrastRatio(fg, bg) * 100) / 100, min });
  const glass = glassFill(p, mode);
  for (const fg of TEXT_TOKENS) {
    for (const bg of TEXT_SURFACES) add(`${fg} on ${bg}`, c(fg), c(bg), 4.5);
    add(`${fg} on the rail pill glass`, c(fg), glass, 4.5);
  }
  for (const bg of LINE_SURFACES) add(`--line-strong on ${bg}`, c("--line-strong"), c(bg), 3);
  return out.sort((a, b) => a.ratio / a.min - b.ratio / b.min);
}

export function contrastFailures(p: Record<string, string>, mode: "dark" | "light"): PairResult[] {
  return paletteContrast(p, mode).filter((r) => r.ratio < r.min);
}
