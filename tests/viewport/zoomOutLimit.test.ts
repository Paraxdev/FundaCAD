// The zoom-out limit. Reported from the running app: wheeling out on the dome
// radio reached a 200000mm grid step with the part nowhere to be seen, because it
// had shrunk far below a pixel while the grid kept growing; later, a fixed 5000mm
// floor left a 2mm part a fifth of a pixel across.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  ZOOM_OUT_CEILING,
  ZOOM_OUT_EMPTY,
  ZOOM_OUT_FACTOR,
  maxViewHalfHeight,
} from "../../src/viewport/clipPlanes";
import { niceStep } from "../../src/ui/units";

const VIEW_HEIGHTS_PX = [600, 764, 1300];

/** Pixels across a cube of side `side` at the zoom-out limit. */
function cubePx(side: number, heightPx: number): number {
  const r = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(side, side, side))
    .getBoundingSphere(new THREE.Sphere()).radius;
  return (side * heightPx) / (2 * maxViewHalfHeight(r));
}

describe("maxViewHalfHeight", () => {
  it("keeps a 2 mm part and a 500 mm part at least 8 px across", () => {
    for (const side of [2, 500]) {
      for (const h of VIEW_HEIGHTS_PX) {
        expect(cubePx(side, h), `${side} mm at ${h}px`).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it("scales with the content, so every size ends up about as big on screen", () => {
    for (const side of [5, 40, 500, 5000]) {
      const px = cubePx(side, 764);
      expect(px, `${side} mm`).toBeGreaterThanOrEqual(8);
      expect(px, `${side} mm`).toBeLessThanOrEqual(40);
    }
    expect(maxViewHalfHeight(400)).toBe(400 * ZOOM_OUT_FACTOR);
  });

  it("never gets in the way of framing the model", () => {
    // rig.fit frames the bounding sphere at 1.15x its radius
    for (const r of [0.01, 1, 200, 1e6, 1e8]) {
      expect(maxViewHalfHeight(r), `r ${r}`).toBeGreaterThan(r * 1.15 * 10);
    }
  });

  it("stops at a ceiling for a very large model", () => {
    expect(maxViewHalfHeight(5e4)).toBe(ZOOM_OUT_CEILING);
  });

  it("stops the reported case well short of a 200m grid", () => {
    // dome radio with its antenna, bounding radius about 200mm, 764px tall view
    const halfH = maxViewHalfHeight(200);
    const cell = niceStep(((2 * halfH) / 764) * 64);
    expect(cell).toBeLessThan(200000 / 10);
  });

  it("lets an empty document zoom out to a room-sized view of the grid", () => {
    for (const r of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(maxViewHalfHeight(r as number), `${r}`).toBe(ZOOM_OUT_EMPTY);
    }
    expect(ZOOM_OUT_EMPTY).toBeGreaterThanOrEqual(2000);
  });
});
