// WCAG AA (4.5:1) for the chip and readout text of every shipped theme, on the
// fill each chip really sits on. Noir has no palette in theme.ts, its values are
// the defaults in _tokens.scss.

import { describe, expect, it } from "vitest";
import { themes } from "../../src/ui/theme";

const sources = Object.fromEntries(
  Object.entries(
    import.meta.glob(["../../src/styles/*.scss", "../../src/components/**/*.vue"], { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  ).map(([path, text]) => [path.replace(/^(\.\.\/)+/, ""), text]),
);

type Rgba = [number, number, number, number];

function parse(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1] ?? "", 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (fn) {
    const [r = NaN, g = NaN, b = NaN, a = 1] = (fn[1] ?? "").split(",").map(Number);
    return [r, g, b, a];
  }
  throw new Error(`not a colour: ${value}`);
}

const over = (top: Rgba, under: Rgba): Rgba => {
  const a = top[3];
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
};
const mix = (a: Rgba, pct: number, b: Rgba): Rgba => over([a[0], a[1], a[2], pct], b);

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(fg: Rgba, bg: Rgba): number {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const NOIR = Object.fromEntries(
  [...(sources["src/styles/_tokens.scss"] ?? "").matchAll(/^\s*(--[\w-]+):\s*(#[0-9a-f]{6}|rgba?\([^)]*\));/gim)].map((m) => [m[1], m[2]]),
);

const shipped = themes()
  .filter((t) => !t.custom)
  .map((t) => ({ label: t.label, palette: { ...NOIR, ...("palette" in t ? (t.palette as Record<string, string>) : {}) } }));

function pairs(p: Record<string, string>): [string, Rgba, Rgba][] {
  const c = (name: string) => parse(p[name] ?? `missing ${name}`);
  const panel = c("--panel");
  const panel2 = c("--panel-2");
  // --float-bg: the panel at 72% over the scene a readout floats on.
  const glass = mix(panel, 0.72, c("--viewport-bg"));
  return [
    ["SOLID chip, --text-dim on --panel-2", c("--text-dim"), panel2],
    ["--text-dim on --panel", c("--text-dim"), panel],
    ["SKETCH chip, --accent-hot on --accent-tint over --panel-2", c("--accent-hot"), over(c("--accent-tint"), panel2)],
    ["active segment and render chip, --accent-hot on --accent-tint-2 over --panel", c("--accent-hot"), over(c("--accent-tint-2"), panel)],
    ["readouts, --text-dim on glass", c("--text-dim"), glass],
    ["snap tag and sketch dims, --text on glass", c("--text"), glass],
    ["constraint glyphs, --accent-hot on glass", c("--accent-hot"), glass],
    ["dimension toggle on, --text on --accent 20% into --panel", c("--text"), mix(c("--accent"), 0.2, panel)],
  ];
}

describe("theme contrast", () => {
  it("covers Noir and the light theme", () => {
    expect(shipped.map((t) => t.label)).toEqual(expect.arrayContaining(["FundaCAD Noir", "Solarized Light"]));
  });

  for (const theme of shipped) {
    it(`${theme.label} chip text reaches WCAG AA`, () => {
      const failing = pairs(theme.palette)
        .map(([what, fg, bg]) => ({ what, ratio: Math.round(contrast(fg, bg) * 100) / 100 }))
        .filter((r) => r.ratio < 4.5);
      expect(failing).toEqual([]);
    });
  }

  it("no chip keeps a hard coded dark fill that stays dark on a light theme", () => {
    const dark = /rgba?\(\s*(?:22,\s*24,\s*29|18,\s*20,\s*25)\b/;
    const offenders = Object.entries(sources)
      .filter(([, text]) => dark.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
