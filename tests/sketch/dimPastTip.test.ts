// The value box stands past the arrow's tip, clear of the arrow, and stays on
// the canvas. Before this it hung 16px down and right of the arrow's base, over
// the arrow itself whenever the arrow pointed down or right.

import { describe, expect, it } from "vitest";
import { pastTip, type ScreenRect } from "../../src/sketch/dimInput";

const VIEW: ScreenRect = { left: 0, top: 0, right: 1400, bottom: 900 };
const BOX = { w: 160, h: 30 };
const PAST = 10;

function clearOfArrow(at: { left: number; top: number }, base: { x: number; y: number }, tip: { x: number; y: number }): boolean {
  for (let i = 0; i <= 20; i++) {
    const x = base.x + ((tip.x - base.x) * i) / 20;
    const y = base.y + ((tip.y - base.y) * i) / 20;
    if (x >= at.left && x <= at.left + BOX.w && y >= at.top && y <= at.top + BOX.h) return false;
  }
  return true;
}

const inside = (at: { left: number; top: number }, r: ScreenRect) =>
  at.left >= r.left && at.top >= r.top && at.left + BOX.w <= r.right && at.top + BOX.h <= r.bottom;

describe("pastTip", () => {
  it("stands the box beyond a right pointing tip, centred on the arrow", () => {
    expect(pastTip({ x: 600, y: 400 }, { x: 45, y: 0 }, BOX, VIEW)).toEqual({ left: 610, top: 385 });
  });

  it("stands the box above an upward tip", () => {
    const at = pastTip({ x: 600, y: 400 }, { x: 0, y: -45 }, BOX, VIEW);
    expect(at.top + BOX.h).toBe(390);
    expect(at.left + BOX.w / 2).toBe(600);
  });

  it("is clear of the arrow where the old base offset sat on it", () => {
    const base = { x: 600, y: 400 };
    const tip = { x: 632, y: 432 };
    const old = { left: base.x + 16, top: base.y + 16 };
    expect(clearOfArrow(old, base, tip)).toBe(false);
    expect(clearOfArrow(pastTip(tip, { x: 32, y: 32 }, BOX, VIEW), base, tip)).toBe(true);
  });

  it("flips beside the tip at the right edge, still clear of the arrow", () => {
    const base = { x: 1290, y: 400 };
    const tip = { x: 1335, y: 400 };
    const at = pastTip(tip, { x: 45, y: 0 }, BOX, VIEW);
    expect(inside(at, VIEW)).toBe(true);
    expect(clearOfArrow(at, base, tip)).toBe(true);
  });

  it("flips behind the base when the tip is in a corner", () => {
    const base = { x: 1342, y: 885 };
    const tip = { x: 1387, y: 885 };
    const at = pastTip(tip, { x: 45, y: 0 }, BOX, VIEW);
    expect(inside(at, VIEW)).toBe(true);
    expect(clearOfArrow(at, base, tip)).toBe(true);
    expect(at.left + BOX.w).toBe(base.x - 10);
  });

  it("goes down and right of an arrow seen end on", () => {
    const at = pastTip({ x: 600, y: 400 }, { x: 0, y: 0 }, BOX, VIEW);
    expect(at.left).toBeGreaterThan(600 - BOX.w / 2);
    expect(at.top).toBeGreaterThan(400);
  });

  it("is clamped onto a canvas too small for any side", () => {
    const tiny: ScreenRect = { left: 10, top: 10, right: 200, bottom: 50 };
    const at = pastTip({ x: 100, y: 30 }, { x: 45, y: 0 }, BOX, tiny);
    expect(inside(at, tiny)).toBe(true);
  });

  it("keeps a wide box, one carrying a refusal, right past a slanted tip", () => {
    const wide = { w: 316, h: 120 };
    const base = { x: 600, y: 400 };
    const tip = { x: 632, y: 432 };
    const at = pastTip(tip, { x: 32, y: 32 }, wide, VIEW);
    const dx = Math.max(at.left - tip.x, 0, tip.x - (at.left + wide.w));
    const dy = Math.max(at.top - tip.y, 0, tip.y - (at.top + wide.h));
    expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(PAST);
    for (let i = 0; i <= 20; i++) {
      const x = base.x + ((tip.x - base.x) * i) / 20;
      const y = base.y + ((tip.y - base.y) * i) / 20;
      expect(x >= at.left && x <= at.left + wide.w && y >= at.top && y <= at.top + wide.h).toBe(false);
    }
  });
});
