// WCAG AA (4.5:1) for the chip and readout text of every shipped theme, on the
// fill each chip really sits on. Noir has no palette in theme.ts, its values are
// the defaults in _tokens.scss.

import { describe, expect, it } from "vitest";
import {
  CONTROL_EDGE_SHARE,
  type Rgba,
  contrastFailures,
  contrastRatio as contrast,
  deltaE2000,
  lightness,
  mix,
  over,
  paletteContrast,
  parseColor as parse,
} from "../../src/ui/contrast";
import { themes } from "../../src/ui/theme";

const sources = Object.fromEntries(
  Object.entries(
    import.meta.glob(["../../src/styles/**/*.scss", "../../src/components/**/*.vue"], {
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

  it("checks every signal colour as text on the panels and the pick line on the scene", () => {
    const names = paletteContrast(shipped[0]!.palette, "dark").map((r) => r.what);
    for (const fg of ["--ok", "--warn", "--error"]) {
      for (const bg of ["--panel", "--panel-2"]) expect(names).toContain(`${fg} on ${bg}`);
    }
    expect(names).toContain("--pick-line on --viewport-bg");
  });

  it("checks the control edge against the surface around each field like control and against its own fill", () => {
    const names = paletteContrast(shipped[0]!.palette, "dark").map((r) => r.what);
    for (const fill of ["the field well", "the empty checkbox and slider rail", "the switch track"]) {
      for (const on of ["--panel", "--panel-2", "the panel glass"]) {
        expect(names).toContain(`--control-edge on ${fill} against ${on}`);
        expect(names).toContain(`--control-edge on ${fill} on ${on}, against the fill`);
      }
    }
  });

  it("fails a control edge that fades into the panel", () => {
    const faint = { ...shipped[0]!.palette, "--control-edge": "rgba(246, 240, 228, 0.12)" };
    expect(contrastFailures(faint, "dark").map((r) => r.what)).toContain(
      "--control-edge on the field well against --panel",
    );
  });

  it("_tokens.scss mixes the control edge from the text colour at the share the maths assumes", () => {
    const tokens = sources["src/styles/_tokens.scss"] ?? "";
    const pct = (mode: "dark" | "light") => Math.round(CONTROL_EDGE_SHARE[mode] * 100);
    const root = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("}", tokens.indexOf(":root {")));
    const light = tokens.slice(tokens.indexOf(":root.theme-light {"));
    expect(root).toContain(`--control-edge: color-mix(in srgb, var(--text) ${pct("dark")}%, transparent);`);
    expect(light.slice(0, light.indexOf("}"))).toContain(
      `--control-edge: color-mix(in srgb, var(--text) ${pct("light")}%, transparent);`,
    );
  });

  // An inset edge, never an outline or border: look H keeps lines off rounded surfaces.
  const EDGED: [string, string][] = [
    ["src/styles/ui/_text-field.scss", ".ui-field {"],
    ["src/styles/ui/_select.scss", ".select-trigger.sm-select,"],
    ["src/styles/ui/_checkbox.scss", ".ui-checkbox-mark {"],
    ["src/styles/ui/_switch.scss", ".ui-switch {"],
    ["src/styles/ui/_segmented.scss", ".ui-segmented-bar {"],
  ];
  for (const [path, selector] of EDGED) {
    it(`${selector.replace(/[\s{,]+$/, "")} draws the control edge inset`, () => {
      const text = sources[path] ?? "";
      const at = text.indexOf(selector);
      expect(at, `${selector} in ${path}`).toBeGreaterThanOrEqual(0);
      expect(text.slice(at, text.indexOf("}", at))).toContain("box-shadow: inset 0 0 0 1px var(--control-edge);");
    });
  }

  it("the slider paints its empty rail in the control edge over the empty well, the range slider too", () => {
    const slider = sources["src/styles/ui/_slider.scss"] ?? "";
    const track = slider.slice(slider.indexOf("@mixin track {"), slider.indexOf("}", slider.indexOf("@mixin track {")));
    expect(track).toContain("linear-gradient(var(--control-edge), var(--control-edge)) var(--check-off)");
    const utilities = sources["src/styles/_utilities.scss"] ?? "";
    for (const pseudo of ["-webkit-slider-runnable-track", "-moz-range-track"]) {
      const at = utilities.indexOf(`.profile-slider .ui-slider-input::${pseudo} {`);
      expect(utilities.slice(at, utilities.indexOf("}", at))).toContain(
        "linear-gradient(var(--control-edge), var(--control-edge)) var(--check-off)",
      );
    }
  });

  it("flags two signal colours a colour vision deficiency merges and lightness does not split", () => {
    const apart = (r: { what: string }) => r.what.endsWith("apart in lightness");
    const merged = { ...shipped[0]!.palette, "--ok": "#17c99a", "--warn": "#7bbf3a" };
    expect(contrastFailures(merged, "dark").map((r) => r.what)).toContain("--ok and --warn apart in lightness");
    const split = { ...merged, "--ok": "#1c6b65", "--warn": "#7a5d00", "--error": "#8a1f1d" };
    const paper = { ...split, "--panel": "#eee8d5", "--panel-2": "#e3ddc7" };
    expect(contrastFailures(paper, "light").filter(apart)).toEqual([]);
  });

  it("measures signal separation as CIE lightness and simulated colour difference", () => {
    expect(lightness(parse("#ffffff"))).toBeCloseTo(100, 1);
    expect(lightness(parse("#777777"))).toBeCloseTo(50.03, 1);
    expect(deltaE2000(parse("#859900"), parse("#b58900"), "deuteranopia")).toBeLessThan(15);
    expect(deltaE2000(parse("#1c6b65"), parse("#7a5d00"), "deuteranopia")).toBeGreaterThan(15);
  });

  for (const theme of shipped) {
    it(`${theme.label} text and signals pass 4.5:1, lines and control edges 3:1, and signals stay apart`, () => {
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
