// The letters typed ahead of a size pick what it is, and a sign makes it an
// offset. Read wrong, "r2.5" is a refused field and "-0.5" a negative radius.

import { describe, expect, it } from "vitest";
import {
  defaultQuantity,
  deltaForSize,
  isAbsolute,
  parseSizeText,
  sizeReadout,
} from "../../src/features/sizeQuantity";
import { tryParseMeasure, unitById } from "../../src/ui/measure";

describe("parseSizeText", () => {
  it("reads r as a radius, either case, with or without a space", () => {
    expect(parseSizeText("r2.5")).toEqual({ quantity: "radius", text: "2.5" });
    expect(parseSizeText("R 2.5")).toEqual({ quantity: "radius", text: "2.5" });
    expect(parseSizeText("r.5")).toEqual({ quantity: "radius", text: ".5" });
  });

  it("reads the diameter signs and d as a diameter", () => {
    expect(parseSizeText("⌀5")).toEqual({ quantity: "diameter", text: "5" });
    expect(parseSizeText("ø5")).toEqual({ quantity: "diameter", text: "5" });
    expect(parseSizeText("Ø 5")).toEqual({ quantity: "diameter", text: "5" });
    expect(parseSizeText("∅5")).toEqual({ quantity: "diameter", text: "5" });
    expect(parseSizeText("d5")).toEqual({ quantity: "diameter", text: "5" });
    expect(parseSizeText("D5")).toEqual({ quantity: "diameter", text: "5" });
  });

  it("reads a leading sign as an offset and keeps a minus", () => {
    expect(parseSizeText("+0.5")).toEqual({ quantity: "offset", text: "0.5" });
    expect(parseSizeText("+ 0.5")).toEqual({ quantity: "offset", text: "0.5" });
    expect(parseSizeText("-0.5")).toEqual({ quantity: "offset", text: "-0.5" });
    expect(parseSizeText(" -0.5 mm")).toEqual({ quantity: "offset", text: "-0.5 mm" });
    expect(parseSizeText("−0.5")).toEqual({ quantity: "offset", text: "−0.5" });
  });

  it("keeps a unit on the number's text", () => {
    expect(parseSizeText("r2.5mm")).toEqual({ quantity: "radius", text: "2.5mm" });
    expect(parseSizeText("⌀1/4 in")).toEqual({ quantity: "diameter", text: "1/4 in" });
  });

  it("names nothing for a bare number or an expression", () => {
    expect(parseSizeText("2.5")).toBeNull();
    expect(parseSizeText("2-1")).toBeNull();
    expect(parseSizeText("")).toBeNull();
  });

  it("leaves a parameter name that starts with r or d alone", () => {
    expect(parseSizeText("depth/2")).toBeNull();
    expect(parseSizeText("r_out")).toBeNull();
    expect(parseSizeText("d")).toBeNull();
    expect(parseSizeText("r")).toBeNull();
  });

  it("does not take a sign after a letter as an offset", () => {
    expect(parseSizeText("r-2")).toEqual({ quantity: "radius", text: "-2" });
  });
});

describe("sizeReadout and deltaForSize", () => {
  it("default to a diameter on a full round and a radius on a partial arc", () => {
    expect(defaultQuantity(true)).toBe("diameter");
    expect(defaultQuantity(false)).toBe("radius");
  });

  it("read one drag three ways", () => {
    expect(sizeReadout("radius", 2, 0.5, false, false)).toBeCloseTo(2.5);
    expect(sizeReadout("diameter", 2, 0.5, false, false)).toBeCloseTo(5);
    expect(sizeReadout("offset", 2, 0.5, false, false)).toBeCloseTo(0.5);
    expect(sizeReadout("offset", 2, -0.65, true, true)).toBeCloseTo(-0.65);
  });

  it("turn each reading back into the same drag", () => {
    expect(deltaForSize("radius", 2, 2.5)).toBeCloseTo(0.5);
    expect(deltaForSize("diameter", 2, 5)).toBeCloseTo(0.5);
    expect(deltaForSize("offset", 2, 0.5)).toBeCloseTo(0.5);
    expect(deltaForSize("offset", 2, -0.5)).toBeCloseTo(-0.5);
  });

  it("an offset is relative, so only it takes a minus sign", () => {
    expect(isAbsolute("radius")).toBe(true);
    expect(isAbsolute("diameter")).toBe(true);
    expect(isAbsolute("offset")).toBe(false);
  });
});

describe("the number's text", () => {
  it("is something the field's own parser reads", () => {
    const mm = unitById("mm");
    for (const [raw, want] of [["+0.5", 0.5], ["-0.5", -0.5], ["−0.5", -0.5], ["r2.5", 2.5], ["⌀5mm", 5], ["d 1/2", 0.5]] as const) {
      expect(tryParseMeasure(parseSizeText(raw)!.text, mm)?.value).toBeCloseTo(want);
    }
  });
});
