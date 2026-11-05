// The sketch dimension layer reads projected points, the canvas and the cards in window pixels, but draws its labels
// and leaders in the CSS pixels the browser build's root zoom then scales.

import { describe, expect, it } from "vitest";
import { layoutUnderZoom } from "../../src/ui/labelClamp";

const Z = 1.75;
const area = { left: 0, top: 0, right: 1400, bottom: 900 };
const none = { left: [], right: [] };

describe("layoutUnderZoom", () => {
  it("puts a label in the open at its projected point once the zoom scales it", () => {
    const [out] = layoutUnderZoom([{ x: 700, y: 420, hw: 20, hh: 8 }], area, none, 6, new Map(), Z);
    expect(out!.at.x * Z).toBeCloseTo(700);
    expect(out!.at.y * Z).toBeCloseTo(420);
    expect(out!.leader).toBeNull();
  });

  it("clamps a label to the canvas edge the window sees, and its leader runs from its border to the point", () => {
    const p = { x: 700, y: 2000 };
    const [out] = layoutUnderZoom([{ ...p, hw: 20, hh: 8 }], area, none, 6, new Map(), Z);
    const c = out!.at;
    expect((c.y + 8 + 6) * Z).toBeCloseTo(900);
    const seg = out!.leader!;
    expect(seg.x2 * Z).toBeCloseTo(p.x);
    expect(seg.y2 * Z).toBeCloseTo(p.y);
    expect(seg.y1).toBeCloseTo(c.y + 8);
  });

  it("keeps a label clear of a card measured in window pixels", () => {
    const card = { left: 0, top: 0, right: 350, bottom: 900 };
    const [out] = layoutUnderZoom(
      [{ x: 175, y: 420, hw: 20, hh: 8 }],
      area,
      { left: [card], right: [] },
      6,
      new Map(),
      Z,
    );
    expect((out!.at.x - 20 - 6) * Z).toBeCloseTo(350);
    expect(out!.leader!.x2 * Z).toBeCloseTo(175);
  });

  it("is layoutLabels at zoom 1", () => {
    const [out] = layoutUnderZoom([{ x: 700, y: 420, hw: 20, hh: 8 }], area, none, 6, new Map(), 1);
    expect(out!.at).toEqual({ x: 700, y: 420 });
  });
});
