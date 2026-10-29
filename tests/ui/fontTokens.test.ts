// A14: the type scale is rem tokens with an 11px floor and 12px errors, and the base components size text only
// through them (VIS-2, SCAN-2).

import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

import { compileMainScss } from "./compileStyles";

const baseSources = import.meta.glob("../../src/styles/ui/*.scss", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const css = postcss.parse(compileMainScss());
const ROOT_PX = 16;

function rootDecls(selector: string): Record<string, string> {
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

function tokenPx(name: string): number {
  const value = rootDecls(":root")[name] ?? "";
  const rem = value.match(/^([0-9.]+)rem$/)?.[1];
  if (rem === undefined) throw new Error(`${name} is "${value}", not a rem length`);
  return Number(rem) * ROOT_PX;
}

/** Font sizes in a stylesheet that are not a --fs-* token: font-size values and the size in a font shorthand. */
function untokenedSizes(source: string): string[] {
  const out: string[] = [];
  postcss.parse(source.replace(/^\s*\/\/.*$/gm, "")).walkDecls((d) => {
    let size: string | null = null;
    if (d.prop === "font-size") size = d.value;
    else if (d.prop === "font" && d.value !== "inherit")
      size = d.value.match(/(?:^|\s)(\S+?)(?:\/|\s+\S+$)/)?.[1] ?? d.value;
    if (size !== null && !/^var\(--fs-[a-z]+\)$/.test(size) && size !== "inherit") out.push(`${d.prop}: ${d.value}`);
  });
  return out;
}

describe("font size tokens", () => {
  it("is a rising rem scale with an 11px floor and 12px for errors", () => {
    const names = ["--fs-micro", "--fs-small", "--fs-body", "--fs-title", "--fs-display"];
    const px = names.map(tokenPx);
    expect(px[0]).toBe(11);
    expect(px[1]).toBe(12);
    expect(px[2]).toBe(13);
    expect([...px].sort((a, b) => a - b)).toEqual(px);
  });

  it("leaves the root text size to the browser and sets the body from the scale", () => {
    expect(rootDecls("html")["font-size"]).toBeUndefined();
    expect(rootDecls("body")["font-size"]).toBe("var(--fs-body)");
  });

  it("shows a field error at the error size", () => {
    expect(rootDecls(".ui-field-row.is-error .ui-field-hint")["font-size"]).toBe("var(--fs-small)");
  });

  it("sizes base component text only through the tokens", () => {
    const found = Object.entries(baseSources).flatMap(([path, text]) =>
      untokenedSizes(text).map((d) => `${path.replace(/^.*\/styles\//, "")}: ${d}`),
    );
    expect(found).toEqual([]);
  });

  it("catches a px size and a px size in a font shorthand", () => {
    const sample =
      ".a { font-size: 10px; }\n.b { font: 700 9px/14px var(--ui); }\n.c { font: 500 var(--fs-micro)/20px var(--ui); }";
    expect(untokenedSizes(sample)).toEqual(["font-size: 10px", "font: 700 9px/14px var(--ui)"]);
  });
});
