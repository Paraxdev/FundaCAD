import postcss, { type Rule } from "postcss";
import * as sass from "sass";
import { describe, expect, it } from "vitest";
import { themes, type ShippedTheme } from "../../src/ui/theme";

// Raw text through Vite, so the test needs no node types. Vitest would hand back
// processed css for a plain .scss import, which is why the query is spelled out.
const sources = import.meta.glob("../../src/styles/*.scss", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const scss = new Map(
  Object.entries(sources).map(([path, text]) => [
    path
      .split("/")
      .pop()!
      .replace(/^_/, "")
      .replace(/\.scss$/, ""),
    text,
  ]),
);
const homeSrc = scss.get("home") ?? "";

const compiled = sass.compileString(scss.get("main") ?? "", {
  url: new URL("file:///styles/main.scss"),
  importers: [
    {
      canonicalize: (url) => new URL(url, "file:///styles/"),
      load: (canonical) => {
        const contents = scss.get(canonical.pathname.split("/").pop()!);
        return contents === undefined ? null : { contents, syntax: "scss" };
      },
    },
  ],
}).css;
const css = postcss.parse(compiled);

// The declarations a selector gets from the rules naming it exactly, later rules
// preferred over earlier ones, as the cascade does between equal selectors.
function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  css.walkRules((rule: Rule) => {
    if (rule.parent?.type !== "root") return;
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
    rule.walkDecls((d) => {
      out[d.prop] = d.value;
    });
  });
  return out;
}

// The last layer of a background list, the solid fill everything else sits on.
function paperBase(background: string | undefined): string {
  const layers = (background ?? "").split(/,(?![^(]*\))/);
  return (layers.at(-1) ?? "").trim();
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const tokensSrc = scss.get("tokens") ?? "";
const NOIR: Record<string, string> = Object.fromEntries(
  [...tokensSrc.matchAll(/^\s*(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gim)].map((m) => [m[1], m[2]]),
);
const SOLARIZED_LIGHT: Record<string, string> =
  (themes().find((t) => t.id === "solarized-light") as ShippedTheme | undefined)?.palette ?? {};

const glass = [
  ".home-side",
  ".home-tools",
  ".home-card",
  ".home-example",
  ".home-new-card",
  ".home-drawer",
  ".home-news",
];

describe("Home wears the app's glass", () => {
  it.each(glass)("%s has the floating panels' fill, blur, border and shadow", (sel) => {
    const d = decls(sel);
    expect(d["backdrop-filter"]).toBe("var(--float-blur)");
    expect(d.background).toMatch(/^var\(--glass-sheen\), var\(--float-bg(-solid)?\)$/);
    expect(d.border).toBe("1px solid var(--float-line)");
    expect(d["box-shadow"]).toBe("var(--glass-inset), var(--float-shadow)");
    expect(d["border-radius"]).toMatch(/^var\(--float-(tile-)?radius\)$/);
    expect(d["corner-shape"]).toBe("squircle");
    expect(decls(`${sel}::after`).background).toBe("var(--glass-rim)");
  });

  it("puts Home on an opaque paper by default, not the dimmed workspace", () => {
    const d = decls(".home::before");
    expect(d.background).not.toBe(decls(".cmdk-backdrop").background);
    expect(d["backdrop-filter"]).toBeUndefined();
    expect(d.background).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(paperBase(d.background)).toBe("var(--bg)");
    expect(decls(".home").background).toBe("transparent");
  });

  it.each([
    ["FundaCAD Noir", NOIR, (l: number) => l < 0.05],
    ["Solarized Light", SOLARIZED_LIGHT, (l: number) => l > 0.85],
  ] as const)("gives %s a paper of its own tone", (_name, palette, ok) => {
    const base = paperBase(decls(".home::before").background);
    const hex = palette[base.slice(4, -1)] ?? "";
    expect(hex, base).toMatch(/^#[0-9a-f]{6}$/i);
    expect(ok(luminance(hex))).toBe(true);
  });

  // Any of these makes .home a backdrop root, and the glass inside it would blur nothing.
  it("leaves .home free of what would stop the glass inside it seeing the workspace", () => {
    const d = decls(".home");
    for (const p of ["filter", "backdrop-filter", "opacity", "mask", "clip-path", "mix-blend-mode", "will-change"]) {
      expect(d[p], p).toBeUndefined();
    }
  });

  it("keeps the dimmed workspace behind Home for whoever picks it", () => {
    const scrim = decls(".cmdk-backdrop");
    const d = decls(".home.bg-workspace::before");
    expect(d.background).toBe(scrim.background);
    expect(d["backdrop-filter"]).toBe(scrim["backdrop-filter"]);
    expect(decls("html.no-glass-blur .home.bg-workspace::before").background).toBe("var(--viewport-bg)");
  });

  it("covers Home with the user's picture, toned down by the theme's paper", () => {
    const d = decls(".home.bg-image::before");
    expect(d.background).toMatch(/var\(--home-image\) center ?\/ ?cover no-repeat/);
    expect(d.background).toMatch(/^linear-gradient\(color-mix\(in srgb, var\(--bg\) \d+%, transparent\)/);
    expect(paperBase(d.background)).toBe("var(--bg)");
    expect(d["backdrop-filter"]).toBeUndefined();
  });

  it("keeps the same paper when the glass cannot blur", () => {
    expect(decls("html.no-glass-blur .home::before").background).toBeUndefined();
  });

  it("takes every colour on Home from the theme", () => {
    expect(homeSrc).not.toBe("");
    expect(homeSrc.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []).toEqual([]);
    expect(homeSrc).not.toMatch(/var\(--raised/);
  });
});
