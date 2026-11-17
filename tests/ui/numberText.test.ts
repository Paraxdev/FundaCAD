import { describe, expect, it } from "vitest";

const sources = {
  ...import.meta.glob("../../src/**/*.{ts,vue}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../plugins/**/*.{ts,vue}", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

const NAMES = "displayRound|roundForDisplay|toUnit|displayValue";
// A rounded number spelled into text with a point: it must go through spellNumber, spellRounded or numberText.
const HAND_SPELLED = new RegExp(String.raw`(?:\$\{|String\(|\{\{)\s*(?:${NAMES})\(`, "g");

function handSpelled(text: string): string[] {
  return [...text.matchAll(HAND_SPELLED)].map((m) => m[0]);
}

describe("numbers in text", () => {
  it("scans real files", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(300);
    expect(Object.keys(sources).some((p) => p.includes("/plugins/FundaCAD.PrintToolbox/"))).toBe(true);
  });

  it("no source spells a rounded number with a point by hand", () => {
    const found = Object.entries(sources).flatMap(([path, text]) => handSpelled(text).map((hit) => `${path}: ${hit}`));
    expect(found).toEqual([]);
  });

  it("reports every pattern it guards", () => {
    const bait = [
      "const a = `${displayRound(x)} mm`;",
      "const b = `at ${ roundForDisplay(y) }`;",
      "const c = `${toUnit(v, u)}`;",
      "const d = `${displayValue(v, k)}°`;",
      "const e = String(displayRound(x));",
      "const f = String( toUnit(v, u));",
      "<span>{{ displayRound(m) }} g</span>",
      "<span>{{displayValue(m)}}</span>",
    ].join("\n");
    expect(handSpelled(bait)).toEqual([
      "${displayRound(",
      "${ roundForDisplay(",
      "${toUnit(",
      "${displayValue(",
      "String(displayRound(",
      "String( toUnit(",
      "{{ displayRound(",
      "{{displayValue(",
    ]);
  });

  it("lets the spellers and numeric uses through", () => {
    const fine = [
      "const a = `${spellRounded(x)} mm`;",
      "const b = spellNumber(displayValue(v, k));",
      "const c = Math.round(toUnit(v, u));",
      "<span>{{ numberText(m) }} g</span>",
      "const d = `${spelled(displayRound(x))}`;",
    ].join("\n");
    expect(handSpelled(fine)).toEqual([]);
  });
});
