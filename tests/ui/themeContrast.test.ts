// WCAG AA (4.5:1) for the chip and readout text of every shipped theme, on the
// fill each chip really sits on. Noir has no palette in theme.ts, its values are
// the defaults in _tokens.scss.

import { describe, expect, it } from "vitest";
import {
  type Rgba,
  contrastFailures,
  contrastRatio as contrast,
  mix,
  over,
  paletteContrast,
  parseColor as parse,
} from "../../src/ui/contrast";
import { themes } from "../../src/ui/theme";

const sources = Object.fromEntries(
  Object.entries(
    import.meta.glob(["../../src/styles/*.scss", "../../src/components/**/*.vue"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  ).map(([path, text]) => [path.replace(/^(\.\.\/)+/, ""), text]),
);

const NOIR = Object.fromEntries(
  [...(sources["src/styles/_tokens.scss"] ?? "").matchAll(/^\s*(--[\w-]+):\s*(#[0-9a-f]{6}|rgba?\([^)]*\));/gim)].map(
    (m) => [m[1], m[2]],
  ),
);

const shipped = themes()
  .filter((t) => !t.custom)
  .map((t) => ({
    label: t.label,
    mode: t.mode,
    palette: { ...NOIR, ...("palette" in t ? (t.palette as Record<string, string>) : {}) },
  }));

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
    [
      "active segment and render chip, --accent-hot on --accent-tint-2 over --panel",
      c("--accent-hot"),
      over(c("--accent-tint-2"), panel),
    ],
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

  it("checks every text token on every surface and the strong line on panel and raised", () => {
    const names = paletteContrast(shipped[0]!.palette, "dark").map((r) => r.what);
    for (const fg of ["--text", "--text-dim", "--text-mute"]) {
      for (const bg of ["--panel", "--panel-2", "--raised", "--raised-2", "the rail pill glass"]) {
        expect(names).toContain(`${fg} on ${bg}`);
      }
    }
    expect(names).toEqual(expect.arrayContaining(["--line-strong on --panel", "--line-strong on --raised"]));
  });

  for (const theme of shipped) {
    it(`${theme.label} text passes 4.5:1 and the strong line 3:1 on every surface`, () => {
      expect(contrastFailures(theme.palette, theme.mode)).toEqual([]);
    });
  }

  for (const theme of shipped) {
    it(`${theme.label} chip text reaches WCAG AA`, () => {
      const failing = pairs(theme.palette)
        .map(([what, fg, bg]) => ({ what, ratio: Math.round(contrast(fg, bg) * 100) / 100 }))
        .filter((r) => r.ratio < 4.5);
      expect(failing).toEqual([]);
    });
  }

  // The flagged sketch labels and relation symbols carry their state in the text colour, so
  // that colour is read from the stylesheet itself and resolved per theme.
  const FLAGGED: [string, string, string][] = [
    ["src/styles/_browser.scss", ".sketch-dim.conflict", "glass"],
    ["src/styles/_browser.scss", ".sketch-dim.over", "glass"],
    ["src/styles/_browser.scss", ".sketch-glyph.conflict", "glass"],
    ["src/styles/_browser.scss", ".sketch-glyph.over", "glass"],
    ["src/styles/_palette.scss", ".rel-row.conflict .rel-sym", "--panel"],
    ["src/styles/_palette.scss", ".rel-row.over .rel-sym", "--panel"],
  ];

  function ruleColour(path: string, selector: string): string {
    const text = sources[path] ?? "";
    const at = text.indexOf(`${selector} {`);
    const body = at < 0 ? "" : text.slice(at, text.indexOf("}", at));
    return /(?:^|[\s;{])color:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? `no color in ${selector}`;
  }

  function resolve(value: string, p: Record<string, string>): Rgba {
    const token = /^var\((--[\w-]+)\)$/.exec(value);
    if (token) return parse(p[token[1] ?? ""] ?? `missing ${token[1]}`);
    const cm =
      /^color-mix\(in srgb,\s*(var\(--[\w-]+\)|#[0-9a-f]{6})\s+(\d+)%,\s*(var\(--[\w-]+\)|#[0-9a-f]{6})\)$/i.exec(
        value,
      );
    if (cm) return mix(resolve(cm[1] ?? "", p), Number(cm[2]) / 100, resolve(cm[3] ?? "", p));
    return parse(value);
  }

  for (const theme of shipped) {
    it(`${theme.label} flagged sketch labels and relation symbols reach WCAG AA`, () => {
      const p = theme.palette;
      const glass = mix(parse(p["--panel"] ?? ""), 0.72, parse(p["--viewport-bg"] ?? ""));
      const failing = FLAGGED.map(([path, selector, under]) => {
        const bg = under === "glass" ? glass : parse(p[under] ?? "");
        return { selector, ratio: Math.round(contrast(resolve(ruleColour(path, selector), p), bg) * 100) / 100 };
      }).filter((r) => r.ratio < 4.5);
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
