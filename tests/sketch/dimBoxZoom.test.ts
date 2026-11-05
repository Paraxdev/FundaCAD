// The Dimension tool parks its value box beside the projected label point. The point and the canvas are window
// pixels, the box and its gaps CSS pixels the browser build's root zoom scales.

import { describe, expect, it } from "vitest";
import { dimBoxSpot } from "../../src/sketch/dimFlow";

const area = { left: 0, top: 0, right: 1400, bottom: 900 };
// DimInput.position's own step from a window point to the box's CSS left and top, before it dodges the window edge.
const css = (p: { x: number; y: number }, z: number) => ({ left: p.x / z + 16, top: p.y / z + 16 });

describe("dimBoxSpot", () => {
  it("keeps the box 28 CSS px up and left of the point at zoom 1.75", () => {
    const z = 1.75;
    const s = { x: 700, y: 450 };
    const box = css(dimBoxSpot(s, { x: 760, y: 500 }, area, z), z);
    expect(box.left + 170 + 28).toBeCloseTo(s.x / z);
    expect(box.top + 46 + 28).toBeCloseTo(s.y / z);
  });

  it("keeps a box near the canvas edge 12 CSS px inside it at zoom 1.75", () => {
    const z = 1.75;
    const box = css(dimBoxSpot({ x: 1380, y: 880 }, { x: 1300, y: 800 }, area, z), z);
    expect(box.left + 170 + 12).toBeCloseTo(area.right / z);
    expect(box.top + 46 + 12).toBeCloseTo(area.bottom / z);
  });

  it("is the old placement at zoom 1", () => {
    expect(dimBoxSpot({ x: 700, y: 450 }, { x: 760, y: 500 }, area, 1)).toEqual({
      x: 700 - 28 - 170 - 16,
      y: 450 - 28 - 46 - 16,
    });
  });
});
