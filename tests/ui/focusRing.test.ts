// The keyboard focus ring: one width token, kept in the error state, inset rings that stay inside at any width,
// and a Slider ring WebKit draws (it paints no outline on the thumb pseudo element).

import postcss, { type ChildNode, type Container } from "postcss";
import { describe, expect, it } from "vitest";

import { compileMainScss } from "./compileStyles";

const FOCUS = /:focus(?:-visible|-within)?(?![\w-])/;
const RING = "var(--focus-ring-width)";
const INSET = "calc(-1 * var(--focus-ring-width))";

interface FocusRule {
  selector: string;
  outline?: string;
  width?: string;
  offset?: string;
  within: string[];
}

function atRules(node: ChildNode): string[] {
  const out: string[] = [];
  for (let p: Container | undefined = node.parent; p && p.type !== "root"; p = p.parent as Container | undefined) {
    if (p.type === "atrule")
      out.unshift(`@${(p as unknown as { name: string }).name} ${(p as unknown as { params: string }).params}`);
  }
  return out;
}

function focusRules(css: string): FocusRule[] {
  const out: FocusRule[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (!FOCUS.test(rule.selector)) return;
    const r: FocusRule = { selector: rule.selector.replace(/\s+/g, " "), within: atRules(rule) };
    rule.each((d) => {
      if (d.type !== "decl") return;
      if (d.prop === "outline") r.outline = d.value;
      if (d.prop === "outline-width") r.width = d.value;
      if (d.prop === "outline-offset") r.offset = d.value;
    });
    out.push(r);
  });
  return out;
}

/** Focus rules that draw an outline at a width other than the token, or an inset ring that a wider token pokes out of. */
function ringFaults(css: string): string[] {
  const faults: string[] = [];
  for (const r of focusRules(css)) {
    const drawn = r.outline !== undefined && !/^(none|0)\b/.test(r.outline.trim());
    if (drawn && !r.outline!.trim().startsWith(RING)) faults.push(`${r.selector}: outline ${r.outline}`);
    if (r.width !== undefined && r.width.trim() !== RING) faults.push(`${r.selector}: outline-width ${r.width}`);
    if (r.offset !== undefined && r.offset.trim().startsWith("-"))
      faults.push(`${r.selector}: outline-offset ${r.offset}`);
  }
  return faults;
}

const css = compileMainScss();
// _forced.scss only recolours rings, tests/ui/forcedColors.test.ts covers it.
const rules = focusRules(css).filter((r) => !r.within.some((w) => w.includes("forced-colors")));
const ruleFor = (selector: string) =>
  rules.filter((r) =>
    r.selector
      .split(",")
      .map((s) => s.trim())
      .includes(selector),
  );

const vueStyles = Object.entries(
  import.meta.glob("../../src/components/**/*.vue", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >,
).map(([path, text]): [string, string] => [
  path,
  [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1] ?? "")
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1"),
]);

describe("the focus ring", () => {
  it("is a 2px token on :root", () => {
    const tokens = postcss.parse(css);
    let width: string | undefined;
    tokens.walkRules((rule) => {
      if (rule.selector.trim() !== ":root") return;
      rule.walkDecls("--focus-ring-width", (d) => {
        width = d.value;
      });
    });
    expect(width).toBe("2px");
  });

  it("draws every focus outline in the stylesheets at the token width, inset rings at minus the token", () => {
    expect(ringFaults(css)).toEqual([]);
  });

  it("draws no focus outline in a component style at a fixed width", () => {
    const faults = vueStyles.flatMap(([path, style]) => ringFaults(style).map((f) => `${path} ${f}`));
    expect(faults).toEqual([]);
  });

  it("flags a fixed width, a fixed outline-width and a fixed inset offset, and passes none and the token", () => {
    expect(
      ringFaults(
        [
          ".a:focus-visible { outline: 1px solid red; }",
          ".b:focus-within { outline-width: 3px; }",
          ".c:focus-visible { outline-offset: -2px; }",
          ".d > input:focus { outline: none; }",
          ".e:focus-visible { outline: var(--focus-ring-width) solid var(--accent); outline-offset: calc(-1 * var(--focus-ring-width)); }",
          ".f.is-selected { outline: 2px solid var(--accent); }",
        ].join("\n"),
      ),
    ).toEqual([
      ".a:focus-visible: outline 1px solid red",
      ".b:focus-within: outline-width 3px",
      ".c:focus-visible: outline-offset -2px",
    ]);
  });

  it("rings a field well at the token width, offset 1px, and keeps the accent ring in the error state", () => {
    expect(ruleFor(".ui-field:focus-within")).toEqual([
      { selector: ".ui-field:focus-within", outline: `${RING} solid var(--accent)`, offset: "1px", within: [] },
    ]);
    const error = rules.filter((r) => r.selector.includes(".is-error"));
    expect(error.filter((r) => r.outline !== undefined || r.width !== undefined)).toEqual([]);
    expect(css).not.toMatch(/\.ui-field\.is-error:focus-within\s*\{[^}]*outline/);
  });

  it("rings the on-canvas value box and the unit select like a field", () => {
    for (const selector of [".dim-field input:focus", ".units select:focus"]) {
      expect(ruleFor(selector), selector).toEqual([
        { selector, outline: `${RING} solid var(--accent)`, offset: "1px", within: [] },
      ]);
    }
  });

  it("rings the whole Slider through :has, and keeps the thumb ring only where :has is missing", () => {
    expect(ruleFor(".ui-slider:has(.ui-slider-input:focus-visible)")).toEqual([
      expect.objectContaining({ outline: `${RING} solid var(--accent)`, within: [] }),
    ]);
    const thumbs = rules.filter((r) => /slider-thumb|range-thumb/.test(r.selector) && r.outline !== undefined);
    expect(thumbs.length).toBeGreaterThanOrEqual(2);
    for (const t of thumbs) expect(t.within, t.selector).toEqual(["@supports not selector(:has(*))"]);
  });

  it("insets the segment, tab, menu item and list row rings by the token", () => {
    for (const selector of [
      ".ui-segment:focus-visible",
      ".ui-tab:focus-visible",
      ".ui-menu-item:focus-visible",
      ".ui-list-row:focus-visible",
    ]) {
      expect(
        ruleFor(selector).map((r) => r.offset),
        selector,
      ).toContain(INSET);
    }
  });
});
