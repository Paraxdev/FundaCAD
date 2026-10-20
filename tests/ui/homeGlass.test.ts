import postcss, { type Rule } from "postcss";
import * as sass from "sass";
import { describe, expect, it } from "vitest";

// Raw text through Vite, so the test needs no node types. Vitest would hand back
// processed css for a plain .scss import, which is why the query is spelled out.
const sources = import.meta.glob("../../src/styles/*.scss", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const scss = new Map(
  Object.entries(sources).map(([path, text]) => [path.split("/").pop()!.replace(/^_/, "").replace(/\.scss$/, ""), text]),
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

const glass = [".home-side", ".home-tools", ".home-card", ".home-new-card", ".home-drawer"];

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

  it("dims the workspace behind Home the way a dialog does", () => {
    const scrim = decls(".cmdk-backdrop");
    const d = decls(".home::before");
    expect(d.background).toBe(scrim.background);
    expect(d["backdrop-filter"]).toBe(scrim["backdrop-filter"]);
    expect(decls(".home").background).toBe("transparent");
  });

  // Any of these makes .home a backdrop root, and the glass inside it would blur nothing.
  it("leaves .home free of what would stop the glass inside it seeing the workspace", () => {
    const d = decls(".home");
    for (const p of ["filter", "backdrop-filter", "opacity", "mask", "clip-path", "mix-blend-mode", "will-change"]) {
      expect(d[p], p).toBeUndefined();
    }
  });

  it("puts an opaque backdrop behind Home when the glass cannot blur", () => {
    expect(decls("html.no-glass-blur .home::before").background).toBe("var(--viewport-bg)");
  });

  it("takes every colour on Home from the theme", () => {
    expect(homeSrc).not.toBe("");
    expect(homeSrc.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []).toEqual([]);
    expect(homeSrc).not.toMatch(/var\(--raised/);
  });
});
