// PH-3: a sketch dimension label projected near the left edge drew under the
// Items card.

import { describe, expect, it } from "vitest";
import { clampLabel, labelLeader } from "../../src/ui/labelClamp";

const area = { left: 0, top: 0, right: 1400, bottom: 900 };
const items = { left: 12, top: 48, right: 275, bottom: 888 };
const palette = { left: 1133, top: 64, right: 1370, bottom: 640 };
const cards = { left: [items], right: [palette] };

describe("clampLabel", () => {
  it("moves a label out from under the left card it shares a row with", () => {
    // where PH-3's height label landed: x 0..38 at y 500
    const c = clampLabel(19, 500, 34, 10, area, cards, 6);
    expect(c.x - 34).toBeGreaterThanOrEqual(items.right + 6);
    expect(c.y).toBe(500);
  });

  it("moves a label out from under the right card", () => {
    const c = clampLabel(1200, 300, 30, 10, area, cards, 6);
    expect(c.x + 30).toBeLessThanOrEqual(palette.left - 6);
  });

  it("leaves a label in the open alone", () => {
    expect(clampLabel(700, 640, 30, 10, area, cards, 6)).toEqual({ x: 700, y: 640 });
  });

  it("ignores a card that ends above the label's row", () => {
    expect(clampLabel(1200, 800, 30, 10, area, cards, 6)).toEqual({ x: 1200, y: 800 });
  });

  it("keeps a label projected off the view inside it", () => {
    const c = clampLabel(-300, 1200, 30, 10, area, { left: [], right: [] }, 6);
    expect(c).toEqual({ x: 36, y: 884 });
  });

  it("prefers the left card when the free span is too narrow", () => {
    const narrow = { left: [{ left: 0, top: 0, right: 700, bottom: 900 }], right: [{ left: 720, top: 0, right: 1400, bottom: 900 }] };
    const c = clampLabel(710, 450, 30, 10, area, narrow, 6);
    expect(c.x - 30).toBe(706);
  });
});

describe("labelLeader", () => {
  it("runs from the clamped label's border back to where its dimension put it", () => {
    const p = { x: -300, y: 1200 };
    const c = clampLabel(p.x, p.y, 30, 10, area, { left: [], right: [] }, 6);
    const seg = labelLeader(c, 30, 10, p)!;
    expect(seg).not.toBeNull();
    expect({ x: seg.x2, y: seg.y2 }).toEqual(p);
    // starts on the label's box, on the side facing the dimension
    const onX = Math.abs(Math.abs(seg.x1 - c.x) - 30) < 1e-9 && Math.abs(seg.y1 - c.y) <= 10;
    const onY = Math.abs(Math.abs(seg.y1 - c.y) - 10) < 1e-9 && Math.abs(seg.x1 - c.x) <= 30;
    expect(onX || onY).toBe(true);
    expect(seg.x1).toBeLessThan(c.x);
    expect(seg.y1).toBeGreaterThan(c.y);
  });

  it("draws nothing for a label that stayed on its dimension", () => {
    expect(labelLeader({ x: 700, y: 640 }, 30, 10, { x: 700, y: 640 })).toBeNull();
    expect(labelLeader({ x: 700, y: 640 }, 30, 10, { x: 720, y: 645 })).toBeNull();
  });

  it("draws nothing for a stub shorter than the minimum", () => {
    expect(labelLeader({ x: 700, y: 640 }, 30, 10, { x: 734, y: 640 })).toBeNull();
    expect(labelLeader({ x: 700, y: 640 }, 30, 10, { x: 740, y: 640 })).not.toBeNull();
  });

  it("ignores a point that did not project", () => {
    expect(labelLeader({ x: 700, y: 640 }, 30, 10, { x: NaN, y: 3 })).toBeNull();
  });
});
