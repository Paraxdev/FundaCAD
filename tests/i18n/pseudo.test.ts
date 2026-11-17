// Pseudo text: brackets, accents and a tail on every word, with arguments and option keys left as they are.

import { describe, expect, it } from "vitest";
import { formatMessage, parseMessage, type MessageArgs } from "../../src/i18n/format";
import { pseudoNodes } from "../../src/i18n/pseudo";

function pseudo(src: string, args: MessageArgs = {}): string {
  return formatMessage(pseudoNodes(parseMessage(src)), args, "en");
}

describe("pseudoNodes", () => {
  it("brackets and accents text, and gives words of three letters or more a tail", () => {
    expect(pseudo("")).toBe("[]");
    expect(pseudo("Add face")).toBe("[ÅÅddd fááççééé]");
    expect(pseudo("Go up")).toBe("[Gööö üüpp]");
  });

  it("leaves arguments and their values alone", () => {
    expect(pseudoNodes(parseMessage("{n} faces"))).toEqual([
      { t: "text", v: "[" },
      { t: "arg", name: "n", number: false },
      { t: "text", v: " fááççééss" },
      { t: "text", v: "]" },
    ]);
    expect(pseudo("{name} on {n, number}", { name: "Box", n: 12.5 })).toBe("[Box ööñññ 12.5]");
  });

  it("keeps plural and select keys so the same option is chosen", () => {
    const src = "{n, plural, =0 {none} one {# face} other {# faces}}";
    expect([0, 1, 3].map((n) => pseudo(src, { n }))).toEqual(["[ññööññééé]", "[1 fááççééé]", "[3 fááççééss]"]);
    expect(pseudo("{kind, select, spot {Spot} other {Face}}", { kind: "spot" })).toBe("[Spöött]");
  });

  it("makes UI text about 1.7 times longer, above German's growth", () => {
    const sample = ["Add a fixed support", "Pick the faces to load", "Mesh detail", "Run study", "Material", "Gravity"];
    const english = sample.join("").length;
    const stretched = sample.map((s) => pseudo(s)).join("").length;
    expect(stretched / english).toBeGreaterThan(1.5);
  });
});
