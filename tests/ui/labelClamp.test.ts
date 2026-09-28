// PH-3: a sketch dimension label projected near the left edge drew under the
// Items card.

import { describe, expect, it } from "vitest";
import { clampLabel, labelLeader, layoutLabels, type Held, type LabelAt } from "../../src/ui/labelClamp";

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

  // the 760 x 640 stage the review found labels running off: the rail's buttons
  // on the left, the right column reaching above the view
  const narrow = { left: 0, top: 36, right: 760, bottom: 640 };
  const rail = [164, 150, 112, 107, 102, 147, 121, 113, 89, 124, 116, 162, 101, 109, 130, 91, 112, 148, 122].map(
    (right, k) => ({ left: 12, top: 48 + k * 36, right, bottom: 80 + k * 36 }),
  );
  const narrowCards = { left: rail, right: [{ left: 668, top: 16, right: 780, bottom: 596 }] };
  const texts = [51, 51, 51, 51, 51, 51, 44, 51, 51, 44, 68, 68, 68, 68, 68];
  const many = (n: number, x: number, y: number, dx = 9, dy = 7): LabelAt[] =>
    Array.from({ length: n }, (_, k) => ({ x: x + (k % 5) * dx, y: y + (k % 3) * dy, hw: texts[k % texts.length]! / 2, hh: 10 }));
  const clear = (ls: LabelAt[], out: { x: number; y: number }[], a: typeof area, cs: typeof cards) => {
    for (let i = 0; i < ls.length; i++) {
      const b = box(out[i]!, ls[i]!);
      expect(b.left, `${i} left`).toBeGreaterThanOrEqual(a.left);
      expect(b.right, `${i} right`).toBeLessThanOrEqual(a.right);
      expect(b.top, `${i} top`).toBeGreaterThanOrEqual(a.top);
      expect(b.bottom, `${i} bottom`).toBeLessThanOrEqual(a.bottom);
      for (const o of [...cs.left, ...cs.right]) expect(overlaps(b, o), `${i} under a card`).toBe(false);
      for (let j = i + 1; j < ls.length; j++) expect(overlaps(b, box(out[j]!, ls[j]!)), `${i} and ${j}`).toBe(false);
    }
  };
  const rows = (out: { x: number; y: number }[]) => new Set(out.map((c) => Math.round(c.y))).size;
  const cols = (out: { x: number; y: number }[], ls: LabelAt[]) =>
    new Set(out.map((c, i) => Math.round(c.x - ls[i]!.hw))).size;

  it("wraps a full row into a second one inward, never off the view or under a card", () => {
    for (const [x, y] of [[-100, -100], [850, -100], [-100, 720], [850, 720], [380, -150], [380, 760]]) {
      const ls = many(15, x!, y!);
      const out = layoutLabels(ls, narrow, narrowCards, 6);
      clear(ls, out, narrow, narrowCards);
      expect(rows(out), `at ${x},${y}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("wraps into a third row and more", () => {
    const ls = many(40, 380, 760);
    const out = layoutLabels(ls, narrow, narrowCards, 6);
    clear(ls, out, narrow, narrowCards);
    expect(rows(out)).toBeGreaterThanOrEqual(4);
  });

  it("wraps a full column into a second one inward", () => {
    for (const x of [-200, 900]) {
      const ls = many(40, x, 300, 3, 4);
      const out = layoutLabels(ls, narrow, narrowCards, 6);
      clear(ls, out, narrow, narrowCards);
      expect(cols(out, ls)).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps a wide stage clear of its cards in every corner with a crowd", () => {
    const stage = { left: 0, top: 36, right: 1400, bottom: 900 };
    const rightRail = { left: 1088, top: 48, right: 1136, bottom: 520 };
    const wide = { left: [items, ...rail.map((o) => ({ ...o, left: o.left + 276, right: o.right + 276 }))], right: [rightRail, palette] };
    for (const [x, y] of [[-100, -100], [1490, -100], [-100, 990], [1490, 990]]) {
      const ls = many(15, x!, y!);
      const out = layoutLabels(ls, stage, wide, 6);
      clear(ls, out, stage, wide);
    }
  });

  it("keeps each wrapped row in the order its dimensions project", () => {
    const ls = many(15, 380, 760, 20, 0);
    const out = layoutLabels(ls, narrow, narrowCards, 6);
    const byRow = new Map<number, number[]>();
    out.forEach((c, i) => byRow.set(Math.round(c.y), [...(byRow.get(Math.round(c.y)) ?? []), i]));
    for (const ids of byRow.values()) {
      const byPos = [...ids].sort((a, b) => out[a]!.x - out[b]!.x);
      const byDim = [...ids].sort((a, b) => ls[a]!.x - ls[b]!.x || a - b);
      expect(byPos).toEqual(byDim);
    }
  });

  it("does not let a label hovering at the edge jostle the others", () => {
    const held = new Map<number, Held>();
    // three labels well off the bottom, and one whose dimension wobbles across
    // the clamp line while the view pans slowly sideways
    const edge = area.bottom - 6 - 10;
    const at = (t: number): LabelAt[] => {
      const dx = t * 0.7;
      return [
        { x: 600 + dx, y: 1000, hw: 30, hh: 10 },
        { x: 640 + dx, y: 1040, hw: 30, hh: 10 },
        { x: 680 + dx, y: 980, hw: 34, hh: 10 },
        { x: 650 + dx, y: edge + 2.5 * Math.sin(t * 1.3), hw: 26, hh: 10 },
      ];
    };
    let prev = layoutLabels(at(0), area, none, 6, held);
    let toggles = 0;
    let wasIn = held.has(3);
    for (let t = 1; t < 200; t++) {
      const out = layoutLabels(at(t), area, none, 6, held);
      const isIn = held.has(3);
      if (isIn !== wasIn) toggles++;
      for (let i = 0; i < 3; i++) {
        const move = Math.abs(out[i]!.x - prev[i]!.x);
        const allowed = 0.7 + (isIn !== wasIn ? 26 + 34 + 6 : 0) + 1e-9;
        expect(move, `label ${i} at frame ${t}`).toBeLessThanOrEqual(allowed);
        expect(out[i]!.y).toBe(prev[i]!.y);
      }
      wasIn = isIn;
      prev = out;
    }
    expect(toggles).toBeLessThanOrEqual(1);
  });

  it("lets a label leave its edge once it is clearly back on screen", () => {
    const held = new Map<number, Held>();
    const l = (y: number): LabelAt[] => [{ x: 700, y, hw: 30, hh: 10 }];
    layoutLabels(l(900), area, none, 6, held);
    expect(held.get(0)?.edge).toBe("bottom");
    layoutLabels(l(880), area, none, 6, held);
    expect(held.get(0)?.edge).toBe("bottom");
    expect(layoutLabels(l(860), area, none, 6, held)).toEqual([{ x: 700, y: 860 }]);
    expect(held.has(0)).toBe(false);
  });

  it("moves the others no more than the pan and the room a newcomer needs, panning a crowd into each corner", () => {
    const stage = { left: 0, top: 36, right: 1400, bottom: 900 };
    const railL = rail.map((o) => ({ ...o, left: o.left + 276, right: o.right + 276 }));
    const cs = { left: [items, ...railL], right: [{ left: 1088, top: 48, right: 1136, bottom: 520 }, palette] };
    const offsets = Array.from({ length: 15 }, (_, k) => ({
      x: ((k * 37) % 170) - 85,
      y: ((k * 53) % 110) - 55,
      hw: texts[k]! / 2,
      hh: 10,
    }));
    for (const [vx, vy] of [[-4, -3], [4, -3], [-4, 3], [4, 3]]) {
      const held = new Map<number, Held>();
      const at = (t: number) => offsets.map((o) => ({ ...o, x: 700 + o.x + vx! * t, y: 460 + o.y + vy! * t }));
      let prev = layoutLabels(at(0), stage, cs, 6, held);
      let prevKeys = offsets.map((_, i) => held.get(i)?.edge);
      let frames = 0;
      let events = 0;
      for (let t = 1; t <= 260; t++) {
        const ls = at(t);
        const out = layoutLabels(ls, stage, cs, 6, held);
        const on = offsets.map((_, k) => k).filter((k) => held.has(k));
        clear(on.map((k) => ls[k]!), on.map((k) => out[k]!), stage, cs);
        const keys = offsets.map((_, i) => held.get(i)?.edge);
        const changed = keys.some((k, i) => k !== prevKeys[i]);
        if (changed) events++;
        let worst = 0;
        keys.forEach((k, i) => {
          if (k !== prevKeys[i]) return;
          const ex = Math.abs(out[i]!.x - prev[i]!.x) - Math.abs(vx!);
          const ey = Math.abs(out[i]!.y - prev[i]!.y) - Math.abs(vy!);
          worst = Math.max(worst, ex, ey);
        });
        // a newcomer needs at most its own length and a gap
        expect(worst, `frame ${t} going ${vx},${vy}`).toBeLessThanOrEqual(changed ? 68 + 6 : 1e-6);
        if (worst > 1e-6) frames++;
        prev = out;
        prevKeys = keys;
      }
      expect(held.size).toBe(15);
      expect(frames).toBeLessThanOrEqual(events);
    }
  });
});
