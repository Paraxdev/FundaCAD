// The guard behind docs/DESIGN.md. It cannot see a screen, so it holds the three
// rules a reviewer misses most: colours come from the tokens, blur comes from the
// glass, and every token a rule reads exists.
//
// Sources come through Vite (import.meta.glob with ?raw), so the test needs no
// node types. vitest.config.ts lets ?raw through for .scss, or it hands back "".

import { describe, expect, it } from "vitest";

const read = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([path, text]) => [path.replace(/^(\.\.\/)+/, ""), text]));

const vueFiles = read(
  import.meta.glob("../../src/components/**/*.vue", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
);
const scssFiles = read(
  import.meta.glob("../../src/styles/*.scss", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
);

const TOKENS = "src/styles/_tokens.scss";
const GLASS = "src/styles/_glass.scss";

// The colour literals each file holds today. A file may go down, never up; a
// file not listed starts at zero. Write a token (or color-mix of tokens) instead.
const COLOUR_BASELINE: Record<string, number> = {
  "src/components/overlays/PluginSettingsForm.vue": 2,
  "src/components/overlays/RadialMenuHost.vue": 2,
  "src/components/overlays/StressPanel.vue": 2,
  "src/components/shell/LiveSessionPill.vue": 4,
  "src/components/shell/NormalToSketch.vue": 1,
  "src/components/shell/NumberBox.vue": 2,
  "src/components/shell/RoundTripReadout.vue": 1,
  "src/components/shell/SelectionReadout.vue": 1,
  "src/components/shell/SurfaceNodeEditor.vue": 12,
  "src/styles/_base.scss": 1,
  "src/styles/_browser.scss": 18,
  "src/styles/_console.scss": 4,
  "src/styles/_float.scss": 10,
  "src/styles/_glass.scss": 31,
  "src/styles/_home.scss": 50,
  "src/styles/_inspector.scss": 15,
  "src/styles/_layout.scss": 6,
  "src/styles/_modals.scss": 120,
  "src/styles/_notice.scss": 1,
  "src/styles/_palette.scss": 4,
  "src/styles/_renderdock.scss": 5,
  "src/styles/_targetedit.scss": 2,
  "src/styles/_timeline.scss": 5,
  "src/styles/_titlebar.scss": 1,
  "src/styles/_utilities.scss": 13,
};

// Blurs written by hand outside _glass.scss. Anything new uses var(--float-blur),
// which html.no-glass-blur can switch off and the theme can tune in one place.
const BLUR_ALLOWED: Record<string, { count: number; reason: string }> = {
  "src/styles/_browser.scss": { count: 2, reason: "the small sketch dimension chip, a label on the model, not a panel" },
  "src/styles/_console.scss": { count: 2, reason: "base of .logcon, repainted by _glass.scss" },
  "src/styles/_modals.scss": { count: 3, reason: "base of .choice-backdrop and .cmdk-backdrop, repainted by _glass.scss" },
  "src/styles/_targetedit.scss": { count: 2, reason: "base of .tgt-panel, repainted by _glass.scss" },
  "src/styles/_utilities.scss": { count: 2, reason: "base of .prompt, repainted by #viewport .prompt in _glass.scss" },
};

// Read but defined nowhere, so they fall back or paint nothing. Shrink this list,
// never grow it: --danger is --error, --fg is --text, --muted is --text-mute,
// --border is --line, --panel-1 and --bg-panel are --panel, --panel-3 is --panel-2,
// --fg-dim is --text-dim.
const UNDEFINED_ALLOWED = ["--danger", "--fg", "--border", "--muted", "--bg-panel", "--bg-sunken", "--fg-dim", "--panel-1", "--panel-3"];

function styleOf(path: string, text: string): string {
  const css = path.endsWith(".vue") ? [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n") : text;
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function declarations(css: string): { prop: string; value: string }[] {
  return [...css.matchAll(/(?:^|[{;])\s*(-{0,2}[a-zA-Z][\w-]*)\s*:\s*([^;{}]*)(?=[;}])/gm)].map((m) => ({
    prop: (m[1] ?? "").toLowerCase(),
    value: m[2] ?? "",
  }));
}

const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const COLOUR_FN = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
const NAMED = /(?<![\w-])(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink)(?![\w-])/gi;

function colourLiterals(path: string, text: string): number {
  return declarations(styleOf(path, text)).reduce(
    (n, { value }) => n + (value.match(HEX)?.length ?? 0) + (value.match(COLOUR_FN)?.length ?? 0) + (value.match(NAMED)?.length ?? 0),
    0,
  );
}

function handBlurs(path: string, text: string): string[] {
  return declarations(styleOf(path, text))
    .filter(({ prop }) => prop === "backdrop-filter" || prop === "-webkit-backdrop-filter")
    .map(({ value }) => value.trim())
    .filter((value) => value !== "var(--float-blur)" && value !== "none");
}

function names(text: string, re: RegExp): Set<string> {
  return new Set([...text.matchAll(re)].map((m) => m[1] ?? ""));
}

const sources = new Map([...vueFiles, ...scssFiles]);
const tokens = names(scssFiles.get(TOKENS) ?? "", /(--[\w-]+)\s*:/g);
// Set where it is used: an inline :style, a setProperty, a local declaration.
const local = new Set([...sources.values()].flatMap((t) => [...names(t, /['"`](--[\w-]+)['"`]/g), ...names(t, /(?<![\w(-])(--[\w-]+)\s*:/g)]));

describe("design spec guard", () => {
  it("reads the sources", () => {
    expect(vueFiles.size).toBeGreaterThan(50);
    expect(scssFiles.size).toBeGreaterThan(15);
    for (const [path, text] of sources) expect(text.length, path).toBeGreaterThan(0);
    expect(tokens.has("--float-blur")).toBe(true);
    expect(tokens.has("--accent")).toBe(true);
  });

  it("adds no raw colour literal to a component or stylesheet", () => {
    const grown = [...sources]
      .filter(([path]) => path !== TOKENS)
      .map(([path, text]) => ({ path, count: colourLiterals(path, text), baseline: COLOUR_BASELINE[path] ?? 0 }))
      .filter(({ count, baseline }) => count > baseline);
    // Use var(--token), or color-mix(in srgb, var(--token) N%, transparent). See docs/DESIGN.md, Tokens.
    expect(grown).toEqual([]);
  });

  it("blurs only through the glass", () => {
    const loose = [...sources]
      .filter(([path]) => path !== TOKENS && path !== GLASS)
      .map(([path, text]) => ({ path, blurs: handBlurs(path, text) }))
      .filter(({ path, blurs }) => blurs.length > (BLUR_ALLOWED[path]?.count ?? 0));
    // Reuse a glass class or add the selector to a list in _glass.scss. See docs/DESIGN.md, The glass recipe.
    expect(loose).toEqual([]);
  });

  it("reads only tokens that exist", () => {
    const missing = [...vueFiles, ...scssFiles]
      .flatMap(([path, text]) => [...names(text, /var\(\s*(--[\w-]+)/g)].map((name) => ({ path, name })))
      .filter(({ name }) => !tokens.has(name) && !local.has(name) && !UNDEFINED_ALLOWED.includes(name));
    expect(missing).toEqual([]);
  });

  it("finds what the check helpers are meant to find", () => {
    expect(colourLiterals("x.vue", "<template/><style>.a { color: #fff; background: rgba(0,0,0,.5); border-color: white }</style>")).toBe(3);
    expect(colourLiterals("x.scss", "#viewport .add, #fade { color: var(--text); }")).toBe(0);
    expect(handBlurs("x.scss", ".a { backdrop-filter: var(--float-blur); } .b { backdrop-filter: blur(8px); }")).toEqual(["blur(8px)"]);
  });
});
