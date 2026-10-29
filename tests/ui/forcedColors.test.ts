// Forced colours (a Windows contrast theme in WebView2) drop shadows and gradients and map every author colour to
// the theme, so _forced.scss redraws control edges, selected states, the ring and the slider in system colours.

import postcss from "postcss";
import { describe, expect, it } from "vitest";

import { compileMainScss } from "./compileStyles";

interface Decl {
  prop: string;
  value: string;
  important: boolean;
}
interface ForcedRule {
  selectors: string[];
  decls: Decl[];
}

function forcedRules(css: string): ForcedRule[] {
  const out: ForcedRule[] = [];
  postcss.parse(css).walkAtRules("media", (at) => {
    if (!/\(forced-colors:\s*active\)/.test(at.params)) return;
    at.walkRules((rule) => {
      const decls: Decl[] = [];
      rule.walkDecls((d) => {
        decls.push({ prop: d.prop, value: d.value.trim(), important: d.important === true });
      });
      out.push({ selectors: rule.selectors.map((s) => s.replace(/\s+/g, " ").trim()), decls });
    });
  });
  return out;
}

const SYSTEM = new Set(
  [
    "Canvas",
    "CanvasText",
    "LinkText",
    "ButtonFace",
    "ButtonText",
    "ButtonBorder",
    "Field",
    "FieldText",
    "Highlight",
    "HighlightText",
    "SelectedItem",
    "SelectedItemText",
    "GrayText",
    "currentColor",
  ].map((c) => c.toLowerCase()),
);
const WORDS = new Set(["solid", "none", "inset", "linear-gradient", "to", "right", "var", "transparent"]);
// Lengths and positions only, never a colour token.
const VARS = new Set(["--ui-slider-fill", "--profile-from", "--profile-to", "--focus-ring-width"]);
const COLOUR_PROP = /^(color|background(-color)?|outline(-color)?|border(-[a-z]+)*|fill|stroke|box-shadow)$/;

/** Colour values a forced rule sets that are not system colours: a theme token or a literal gets mapped away. */
function colourFaults(rules: ForcedRule[]): string[] {
  const faults: string[] = [];
  for (const r of rules)
    for (const d of r.decls) {
      if (!COLOUR_PROP.test(d.prop)) continue;
      const bad = d.value
        .split(/[\s,()]+/)
        .filter((t) => t !== "")
        .filter((t) => !/^-?[\d.]+(px|%)?$/.test(t) && !WORDS.has(t) && !SYSTEM.has(t.toLowerCase()) && !VARS.has(t));
      if (bad.length > 0) faults.push(`${r.selectors.join(", ")} ${d.prop}: ${bad.join(" ")}`);
    }
  return faults;
}

const rules = forcedRules(compileMainScss());
const declsFor = (selector: string) => rules.filter((r) => r.selectors.includes(selector)).flatMap((r) => r.decls);
const value = (selector: string, prop: string) => {
  const d = declsFor(selector).filter((x) => x.prop === prop);
  return d.length === 0 ? undefined : `${d[d.length - 1]!.value}${d[d.length - 1]!.important ? " !important" : ""}`;
};

describe("forced colours", () => {
  it("are drawn by a block main.scss compiles", () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  it("redraw the control edge as an inset ButtonText outline at no specificity, so every focus ring wins", () => {
    const edge = rules.find((r) => r.decls.some((d) => d.prop === "outline" && d.value === "1px solid ButtonText"));
    expect(edge).toBeDefined();
    expect(edge!.selectors).toHaveLength(1);
    const sel = edge!.selectors[0]!;
    expect(sel.startsWith(":where(") && sel.endsWith(")")).toBe(true);
    for (const control of [
      ".ui-field",
      ".sm-select",
      ".sm-input",
      ".ui-checkbox-mark",
      ".ui-switch",
      ".ui-segmented-bar",
    ])
      expect(sel, control).toContain(control);
    expect(edge!.decls).toContainEqual({ prop: "outline-offset", value: "-1px", important: false });
  });

  it("fill every selected and pressed state with Highlight and HighlightText", () => {
    for (const selector of [
      ".ui-list-row.is-selected",
      ".ui-segment.is-selected",
      ".ui-tabs-nav .ui-tab.is-selected",
      ".ui-checkbox.is-on .ui-checkbox-mark",
      ".ui-checkbox.is-mixed .ui-checkbox-mark",
      ".ui-switch.is-on",
      ".feature-row.selected",
      ".tree-folder.selected",
      "#timeline .timeline-node.selected",
      ".opt-row.selected",
      ".rail-btn.active",
      ".float-tab.active",
      ".icon-btn.active",
      ".btn.is-on",
      ".cmdk-item.active",
    ]) {
      expect(value(selector, "background-color"), selector).toBe("Highlight !important");
      expect(value(selector, "color"), selector).toBe("HighlightText !important");
    }
  });

  it("keep the tab bar, the tick and the switch knob visible", () => {
    expect(value(".ui-tab.is-selected::after", "background-color")).toBe("Highlight !important");
    expect(value(".ui-checkbox-mark::after", "background-color")).toBe("HighlightText !important");
    expect(value(".ui-switch-knob", "background-color")).toBe("ButtonText !important");
    expect(value(".ui-switch.is-on .ui-switch-knob", "background-color")).toBe("HighlightText !important");
  });

  it("ring focus in Highlight over every ring colour", () => {
    expect(value(":focus-visible", "outline-color")).toBe("Highlight !important");
    expect(value(".ui-checkbox-input:focus-visible + .ui-checkbox-mark", "outline-color")).toBe("Highlight !important");
  });

  it("paint the slider rails and thumbs themselves, since forced colours drop their gradients", () => {
    expect(value(".ui-slider-input", "forced-color-adjust")).toBe("none");
    for (const part of ["::-webkit-slider-runnable-track", "::-moz-range-track"]) {
      expect(value(`.ui-slider-input${part}`, "background"), part).toMatch(/Highlight.*ButtonText/);
      expect(value(`.profile-slider .ui-slider-input${part}`, "background"), part).toMatch(/ButtonText.*Highlight/);
    }
    for (const part of ["::-webkit-slider-thumb", "::-moz-range-thumb"])
      expect(value(`.ui-slider-input${part}`, "background-color"), part).toBe("ButtonText !important");
  });

  it("set only system colours", () => {
    expect(colourFaults(rules)).toEqual([]);
  });

  it("flag a theme token, a hex value and a named colour, and pass system colours and position variables", () => {
    const sample = forcedRules(
      [
        "@media (forced-colors: active) {",
        ".a { color: var(--accent); }",
        ".b { background-color: #fff; }",
        ".c { outline: 1px solid red; }",
        ".d { outline: 1px solid ButtonText; outline-offset: -1px; }",
        ".e { background: linear-gradient(to right, Highlight var(--ui-slider-fill), ButtonText var(--ui-slider-fill)); }",
        ".f { color: HighlightText !important; forced-color-adjust: none; }",
        "}",
        ".g { color: var(--accent); }",
      ].join("\n"),
    );
    expect(colourFaults(sample)).toEqual([".a color: --accent", ".b background-color: #fff", ".c outline: red"]);
  });
});
