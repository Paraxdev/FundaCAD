// The zoom-out ceiling. Reported from the running app: wheeling out on the dome
// radio reached a 200000mm grid step with the part nowhere to be seen, because it
// had shrunk far below a pixel while the grid kept growing.

import { describe, expect, it } from "vitest";
import {
  ZOOM_OUT_FACTOR,
  ZOOM_OUT_FLOOR,
  maxViewHalfHeight,
} from "../../src/viewport/clipPlanes";
import { niceStep } from "../../src/ui/units";

const VIEW_HEIGHTS_PX = [600, 764, 1300];

describe("maxViewHalfHeight", () => {
  it("keeps the model several pixels across at the ceiling", () => {
    for (const r of [1, 20, 200, 5000, 1e5]) {
      for (const h of VIEW_HEIGHTS_PX) {
        const halfH = maxViewHalfHeight(r);
        const diameterPx = (2 * r) / ((2 * halfH) / h);
        if (halfH === r * ZOOM_OUT_FACTOR) {
          expect(diameterPx, `r ${r} at ${h}px`).toBeGreaterThanOrEqual(4);
        }
      }
    }
  });

  it("never gets in the way of framing the model", () => {
    // rig.fit frames the bounding sphere at 1.15x its radius
    for (const r of [0.01, 1, 200, 1e6]) {
      expect(maxViewHalfHeight(r), `r ${r}`).toBeGreaterThan(r * 1.15 * 10);
    }
  });

  it("stops the reported case well short of a 200m grid", () => {
    // dome radio with its antenna, bounding radius about 200mm, 764px tall view
    const halfH = maxViewHalfHeight(200);
    const cell = niceStep(((2 * halfH) / 764) * 64);
    expect(cell).toBeLessThan(200000 / 10);
  });

  it("still lets an empty or tiny document zoom out to a room-sized view", () => {
    for (const r of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      const halfH = maxViewHalfHeight(r as number);
      expect(Number.isFinite(halfH), `${r}`).toBe(true);
      expect(halfH).toBeGreaterThanOrEqual(ZOOM_OUT_FLOOR);
    }
  });
});
