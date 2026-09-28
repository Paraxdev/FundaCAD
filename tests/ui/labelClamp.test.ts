// PH-3: a sketch dimension label projected near the left edge drew under the
// Items card.

import { describe, expect, it } from "vitest";
import { clampLabel, labelLeader, layoutLabels, type LabelAt } from "../../src/ui/labelClamp";

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

describe("layoutLabels", () => {
  const none = { left: [], right: [] };
  const box = (c: { x: number; y: number }, l: LabelAt) =>
    ({ left: c.x - l.hw, top: c.y - l.hh, right: c.x + l.hw, bottom: c.y + l.hh });
  const overlaps = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const noOverlap = (ls: LabelAt[], out: { x: number; y: number }[]) => {
    for (let i = 0; i < ls.length; i++)
      for (let j = i + 1; j < ls.length; j++)
        expect(overlaps(box(out[i]!, ls[i]!), box(out[j]!, ls[j]!)), `${i} and ${j}`).toBe(false);
  };
  const inside = (ls: LabelAt[], out: { x: number; y: number }[]) =>
    out.forEach((c, i) => {
      const b = box(c, ls[i]!);
      expect(b.left).toBeGreaterThanOrEqual(area.left);
      expect(b.right).toBeLessThanOrEqual(area.right);
      expect(b.top).toBeGreaterThanOrEqual(area.top);
      expect(b.bottom).toBeLessThanOrEqual(area.bottom);
    });

  it("leaves labels that did not need clamping alone", () => {
    const ls = [
      { x: 700, y: 400, hw: 30, hh: 10 },
      { x: 710, y: 405, hw: 30, hh: 10 },
    ];
    expect(layoutLabels(ls, area, cards, 6)).toEqual([{ x: 700, y: 400 }, { x: 710, y: 405 }]);
  });

  it("spreads labels clamped against the same card up and down, in the order they project", () => {
    // the rectangle's width and height, both behind the Items card
    const ls = [
      { x: 200, y: 672, hw: 34, hh: 10 },
      { x: 150, y: 684, hw: 34, hh: 10 },
    ];
    const out = layoutLabels(ls, area, cards, 6);
    noOverlap(ls, out);
    expect(out[0]!.y).toBeLessThan(out[1]!.y);
    out.forEach((c, i) => expect(c.x - ls[i]!.hw).toBeGreaterThanOrEqual(items.right + 6));
  });

  it("spreads labels clamped to the bottom along it", () => {
    const ls = [
      { x: 710, y: 1100, hw: 30, hh: 10 },
      { x: 700, y: 1050, hw: 30, hh: 10 },
      { x: 705, y: 1300, hw: 30, hh: 10 },
    ];
    const out = layoutLabels(ls, area, cards, 6);
    noOverlap(ls, out);
    inside(ls, out);
    expect(out.every((c) => c.y === 884)).toBe(true);
    // ordered by where they project across, not by how far off they are
    expect(out[1]!.x).toBeLessThan(out[2]!.x);
    expect(out[2]!.x).toBeLessThan(out[0]!.x);
  });

  it("keeps the order while panning", () => {
    const at = (dx: number) =>
      layoutLabels(
        [
          { x: 400 + dx, y: -80, hw: 30, hh: 10 },
          { x: 390 + dx, y: -40, hw: 30, hh: 10 },
        ],
        area,
        none,
        6,
      );
    for (let dx = -600; dx <= 1200; dx += 37) {
      const out = at(dx);
      expect(out[1]!.x, `dx ${dx}`).toBeLessThan(out[0]!.x);
    }
  });

  it("does not stack labels in any corner", () => {
    const off = [
      { x: -200, y: -150 },
      { x: 1700, y: -150 },
      { x: -200, y: 1150 },
      { x: 1700, y: 1150 },
    ];
    for (const o of off) {
      // a small rectangle's width below or above it, height beside it, and two more
      const ls = [
        { x: o.x, y: o.y + 30, hw: 30, hh: 10 },
        { x: o.x - 30, y: o.y, hw: 30, hh: 10 },
        { x: o.x + 5, y: o.y - 30, hw: 36, hh: 10 },
        { x: o.x + 30, y: o.y + 4, hw: 24, hh: 10 },
      ];
      for (const cs of [none, cards]) {
        const out = layoutLabels(ls, area, cs, 6);
        noOverlap(ls, out);
        inside(ls, out);
      }
    }
  });

  it("does not stack a label clamped to a side on one clamped to the bottom", () => {
    // off the left, the height's label just inside the bottom row, the width's below it
    const ls = [
      { x: -60, y: 880, hw: 30, hh: 10 },
      { x: -20, y: 960, hw: 30, hh: 10 },
    ];
    const out = layoutLabels(ls, area, { left: [], right: [] }, 6);
    noOverlap(ls, out);
    inside(ls, out);
  });

  it("does not stack labels off each edge", () => {
    const edges = [
      { x: 700, y: -100 },
      { x: 700, y: 1000 },
      { x: -100, y: 450 },
      { x: 1500, y: 450 },
    ];
    for (const e of edges) {
      const ls = [0, 1, 2, 3, 4].map((k) => ({ x: e.x + k * 3, y: e.y + k * 4, hw: 28 + k, hh: 10 }));
      for (const cs of [none, cards]) {
        const out = layoutLabels(ls, area, cs, 6);
        noOverlap(ls, out);
        inside(ls, out);
      }
    }
  });

  it("gives each leader its own dimension", () => {
    const ls = [
      { x: 700, y: 1000, hw: 30, hh: 10 },
      { x: 702, y: 1040, hw: 30, hh: 10 },
    ];
    const out = layoutLabels(ls, area, none, 6);
    out.forEach((c, i) => {
      const seg = labelLeader(c, ls[i]!.hw, ls[i]!.hh, ls[i]!)!;
      expect({ x: seg.x2, y: seg.y2 }).toEqual({ x: ls[i]!.x, y: ls[i]!.y });
    });
  });
});
