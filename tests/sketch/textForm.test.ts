// The Text tool's panel is now a component, so its form<->value mapping is a
// pure function and can be tested without a DOM. Two things here are easy to get
// wrong in a port and invisible afterwards: "bolditalic" has to light BOTH
// checkboxes, and an empty numeric field has to fall back rather than reach the
// sidecar as NaN.

import { describe, it, expect } from "vitest";
import { initialTextForm, styleOf, textPanelPos, toTextValues } from "../../src/sketch/textForm";

describe("styleOf", () => {
  it("maps the two checkboxes onto the four style names", () => {
    expect(styleOf(false, false)).toBe("regular");
    expect(styleOf(true, false)).toBe("bold");
    expect(styleOf(false, true)).toBe("italic");
    expect(styleOf(true, true)).toBe("bolditalic");
  });
});

describe("initialTextForm", () => {
  it("lights both checkboxes for bolditalic", () => {
    const f = initialTextForm({ style: "bolditalic" });
    expect(f.bold).toBe(true);
    expect(f.italic).toBe(true);
  });

  it("defaults an unset panel to 10mm regular left-aligned text", () => {
    const f = initialTextForm({});
    expect(f).toEqual({
      text: "", font: "", height: "10", bold: false, italic: false,
      align: "left", angle: "0", boxWidth: "",
    });
  });

  it("leaves the box-width field empty rather than showing a meaningless 0", () => {
    expect(initialTextForm({ boxWidth: 0 }).boxWidth).toBe("");
    expect(initialTextForm({ boxWidth: 25 }).boxWidth).toBe("25");
  });

  it("round-trips an existing text object", () => {
    const v = { text: "Hi", font: "Arial", height: 6, style: "italic", align: "right", angle: 45, boxWidth: 30 } as const;
    expect(toTextValues(initialTextForm(v))).toEqual(v);
  });
});

describe("toTextValues", () => {
  const base = initialTextForm({});

  it("omits font and boxWidth rather than sending empty ones", () => {
    const v = toTextValues(base);
    expect("font" in v).toBe(false);
    expect("boxWidth" in v).toBe(false);
  });

  it("treats a zero or negative box width as no wrap box", () => {
    expect("boxWidth" in toTextValues({ ...base, boxWidth: "0" })).toBe(false);
    expect("boxWidth" in toTextValues({ ...base, boxWidth: "-5" })).toBe(false);
    expect(toTextValues({ ...base, boxWidth: "12.5" }).boxWidth).toBe(12.5);
  });

  it("falls back instead of emitting NaN from a half-typed field", () => {
    const v = toTextValues({ ...base, height: "", angle: "" });
    expect(v.height).toBe(10);
    expect(v.angle).toBe(0);
  });

  it("keeps the text verbatim, trimming is the commit's decision, not this one", () => {
    expect(toTextValues({ ...base, text: "  a\nb  " }).text).toBe("  a\nb  ");
  });
});

describe("textPanelPos", () => {
  const win = { innerWidth: 1000, innerHeight: 800 };

  it("follows the click when there is room", () => {
    expect(textPanelPos({ x: 300, y: 200 }, win)).toEqual({ left: 300, top: 200 });
  });

  it("pulls the panel back inside the right and bottom edges", () => {
    expect(textPanelPos({ x: 990, y: 790 }, win)).toEqual({ left: 684, top: 560 });
  });

  it("keeps an 8px inset at the top and left", () => {
    expect(textPanelPos({ x: -50, y: -50 }, win)).toEqual({ left: 8, top: 8 });
  });
});
