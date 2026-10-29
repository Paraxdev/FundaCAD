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

export type Vision = "normal" | "protanopia" | "deuteranopia" | "tritanopia";

// Machado, Oliveira and Fernandes (2009), severity 1, on linear sRGB.
const DICHROMACY: Record<Exclude<Vision, "normal">, number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

function lab([r, g, b]: Rgba, vision: Vision): [number, number, number] {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  let v = [lin(r), lin(g), lin(b)];
  if (vision !== "normal") {
    const m = DICHROMACY[vision];
    v = [0, 1, 2].map((i) =>
      Math.min(1, Math.max(0, m[i * 3]! * v[0]! + m[i * 3 + 1]! * v[1]! + m[i * 3 + 2]! * v[2]!)),
    );
  }
  const [lr, lg, lb] = v as [number, number, number];
  const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 between two opaque colours as a viewer with `vision` sees them. */
export function deltaE2000(c1: Rgba, c2: Rgba, vision: Vision = "normal"): number {
  const [l1, a1, b1] = lab(c1, vision);
  const [l2, a2, b2] = lab(c2, vision);
  const rad = Math.PI / 180;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const [p1, p2] = [(1 + g) * a1, (1 + g) * a2];
  const [cp1, cp2] = [Math.hypot(p1, b1), Math.hypot(p2, b2)];
  const hue = (b: number, a: number) => (((Math.atan2(b, a) / rad) % 360) + 360) % 360;
  const [h1, h2] = [hue(b1, p1), hue(b2, p2)];
  let dh = cp1 * cp2 === 0 ? 0 : h2 - h1;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh / 2) * rad);
  const lBar = (l1 + l2) / 2;
  const cpBar = (cp1 + cp2) / 2;
  let hBar = h1 + h2;
  if (cp1 * cp2 !== 0) hBar = Math.abs(h1 - h2) <= 180 ? hBar / 2 : hBar < 360 ? (hBar + 360) / 2 : (hBar - 360) / 2;
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * rad) +
    0.24 * Math.cos(2 * hBar * rad) +
    0.32 * Math.cos((3 * hBar + 6) * rad) -
    0.2 * Math.cos((4 * hBar - 63) * rad);
  const rc = 2 * Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7));
  const rt = -Math.sin(2 * 30 * Math.exp(-(((hBar - 275) / 25) ** 2)) * rad) * rc;
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cpBar;
  const sh = 1 + 0.015 * cpBar * t;
  const [dl, dc, dhs] = [(l2 - l1) / sl, (cp2 - cp1) / sc, dH / sh];
  return Math.sqrt(dl ** 2 + dc ** 2 + dhs ** 2 + rt * dc * dhs);
}

/** `ratio` is a contrast ratio, or for an "apart in lightness" pair the L* gap. */
export interface PairResult {
  what: string;
  ratio: number;
  min: number;
}

const TEXT_TOKENS = ["--text", "--text-dim", "--text-mute"];
const TEXT_SURFACES = ["--panel", "--panel-2", "--raised", "--raised-2"];
const LINE_SURFACES = ["--panel", "--raised"];
const SIGNALS = ["--ok", "--warn", "--error"];
const SIGNAL_SURFACES = ["--panel", "--panel-2"];
const EDGE_SURFACES = ["--panel", "--panel-2", "the panel glass"];
const DICHROMATS: Vision[] = ["protanopia", "deuteranopia", "tritanopia"];
const SIGNAL_DELTA_E = 15;
const SIGNAL_LIGHTNESS_GAP = 10;
const RING_SURFACES = ["--panel", "--panel-2", "--raised", "--raised-2", "the panel glass"];
const AXES = ["--axis-x", "--axis-y", "--axis-z"];

/** "high" is the bar the High Contrast themes keep: AAA text, and every line a viewer must find at text contrast. */
export type ContrastLevel = "standard" | "high";
const MINIMA: Record<ContrastLevel, Record<"text" | "line" | "signal" | "edge" | "ring", number>> = {
  standard: { text: 4.5, line: 3, signal: 4.5, edge: 3, ring: 3 },
  high: { text: 7, line: 4.5, signal: 4.5, edge: 4.5, ring: 4.5 },
};

/** The rail pill and readout glass over the bare scene, as _tokens.scss builds --float-bg for each mode. */
export function glassFill(p: Record<string, string>, mode: "dark" | "light"): Rgba {
  const c = (name: string) => parseColor(p[name] ?? `missing ${name}`);
  if (mode === "light") return mix(mix(c("--raised"), 0.7, c("--bg")), 0.97, c("--viewport-bg"));
  return mix(c("--panel"), 0.72, c("--viewport-bg"));
}

/** --control-edge in _tokens.scss is the text colour at this share over the control, for a palette that sets none. */
export const CONTROL_EDGE_SHARE = { dark: 0.5, light: 0.68 };

/** The fills a field like control paints over `under`, as _tokens.scss builds --field-bg and --check-off per mode. */
function controlFills(p: Record<string, string>, mode: "dark" | "light", under: Rgba): [string, Rgba][] {
  const c = (name: string) => parseColor(p[name] ?? `missing ${name}`);
  const text = c("--text");
  const field = mode === "light" ? mix(text, 0.11, mix(c("--raised"), 0.7, c("--bg"))) : over(c("--field-bg"), under);
  const checkOff = mode === "light" ? mix(text, 0.24, under) : over(c("--check-off"), under);
  return [
    ["the field well", field],
    ["the empty checkbox and slider rail", checkOff],
    ["the switch track", c("--raised-2")],
  ];
}

export function controlEdge(p: Record<string, string>, mode: "dark" | "light"): Rgba {
  const set = p["--control-edge"];
  if (set) return parseColor(set);
  const [r, g, b, a] = parseColor(p["--text"] ?? "missing --text");
  return [r, g, b, a * CONTROL_EDGE_SHARE[mode]];
}

/** Every text, line, signal and control edge pair a palette must pass, worst first. `p` is a whole palette, Noir defaults filled in. */
export function paletteContrast(
  p: Record<string, string>,
  mode: "dark" | "light",
  level: ContrastLevel = "standard",
): PairResult[] {
  const c = (name: string) => parseColor(p[name] ?? `missing ${name}`);
  const min = MINIMA[level];
  const out: PairResult[] = [];
  const add = (what: string, fg: Rgba, bg: Rgba, min: number) =>
    out.push({ what, ratio: Math.round(contrastRatio(fg, bg) * 100) / 100, min });
  const glass = glassFill(p, mode);
  for (const fg of TEXT_TOKENS) {
    for (const bg of TEXT_SURFACES) add(`${fg} on ${bg}`, c(fg), c(bg), min.text);
    add(`${fg} on the rail pill glass`, c(fg), glass, min.text);
  }
  add("--on-accent on --accent", c("--on-accent"), c("--accent"), min.text);
  for (const bg of LINE_SURFACES) add(`--line-strong on ${bg}`, c("--line-strong"), c(bg), min.line);
  for (const fg of SIGNALS) for (const bg of SIGNAL_SURFACES) add(`${fg} on ${bg}`, c(fg), c(bg), min.signal);
  for (const bg of RING_SURFACES) {
    add(`the focus ring on ${bg}`, c("--accent"), bg === "the panel glass" ? glass : c(bg), min.ring);
  }
  add("--pick-line on --viewport-bg", c("--pick-line"), c("--viewport-bg"), 3);
  for (const axis of AXES) add(`${axis} on --viewport-bg`, c(axis), c("--viewport-bg"), 3);
  // The edge is an inset line painted over the control's own fill, so it has to stand clear of both sides.
  const edge = controlEdge(p, mode);
  for (const on of EDGE_SURFACES) {
    const under = on === "the panel glass" ? glass : c(on);
    for (const [fill, well] of controlFills(p, mode, under)) {
      const line = over(edge, well);
      add(`--control-edge on ${fill} against ${on}`, line, under, min.edge);
      add(`--control-edge on ${fill} on ${on}, against the fill`, line, well, min.edge);
    }
  }
  // Hue alone does not tell two signals apart when a dichromat sees them merge, so those need a lightness gap.
  SIGNALS.forEach((a, i) =>
    SIGNALS.slice(i + 1).forEach((b) => {
      const merged = DICHROMATS.some((v) => deltaE2000(c(a), c(b), v) < SIGNAL_DELTA_E);
      const gap = Math.round(Math.abs(lightness(c(a)) - lightness(c(b))) * 100) / 100;
      if (merged) out.push({ what: `${a} and ${b} apart in lightness`, ratio: gap, min: SIGNAL_LIGHTNESS_GAP });
    }),
  );
  return out.sort((a, b) => a.ratio / a.min - b.ratio / b.min);
}

export function contrastFailures(
  p: Record<string, string>,
  mode: "dark" | "light",
  level: ContrastLevel = "standard",
): PairResult[] {
  return paletteContrast(p, mode, level).filter((r) => r.ratio < r.min);
}
