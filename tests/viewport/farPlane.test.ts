// The far plane that follows the camera OUT, and the property it exists for: the
// ground grid must never run through it.
//
// This is the bug those rules were written from. The lattice is adaptive — its
// cell tracks the zoom and it runs three viewport diagonals either side of the
// view centre — so zooming out grows it without limit, while far was a flat
// 10000mm. Measured on the running app before the fix: a 200mm grid step reached
// 8000mm from a camera 2813mm out (the lattice started being cut off along a line
// across the view), and a 1000mm step reached 37500mm from 13054mm out (the
// viewport went black — grid, part and all, entirely behind far).
//
// So the assertion is not "far is bigger now". It is that at EVERY zoom the grid
// the app will actually build fits inside the frustum it will actually be drawn
// in, computed from the same functions the app uses.

import { describe, expect, it } from "vitest";
import {
  FAR_AT_REST,
  FAR_FACTOR,
  ORTHO_DEPTH_FACTOR,
  orthoDepth,
  perspFar,
} from "../../src/viewport/clipPlanes";
import { groundGridCells } from "../../src/viewport/scene";
import { niceStep } from "../../src/ui/units";

/** The flat far plane this replaced. */
const OLD_FAR = 10000;

const FOV = 45; // viewport/cameras.ts

/** Viewport sizes to sweep: a laptop, a wide monitor, a tall split pane. */
const VIEWPORTS = [
  [1440, 780],
  [1920, 800],
  [2560, 1300],
  [900, 1200],
] as const;

/** mm per pixel at the pivot, the way the perspective camera computes it. */
function worldPerPixel(distance: number, heightPx: number): number {
  return (2 * Math.tan((FOV * Math.PI) / 360) * distance) / heightPx;
}

/** How far the ground grid reaches from its centre, for a camera this far out —
 *  the same cell and cell-count the app builds (viewport/scene.ts). */
function gridReach(distance: number, wPx: number, hPx: number): number {
  const mmPerPx = worldPerPixel(distance, hPx);
  const cell = niceStep(mmPerPx * 64);
  const diagonalPx = Math.hypot(wPx, hPx);
  const cells = groundGridCells(mmPerPx, diagonalPx, cell);
  // half the span, then out to a CORNER of the square lattice
  return (cell * cells * Math.SQRT2) / 2;
}

describe("perspFar", () => {
  it("leaves close and ordinary views exactly where they were", () => {
    // Everything inside the old far's comfortable range keeps the old number, so
    // no depth precision is spent on views that never had a problem.
    for (const d of [0.5, 10, 120, 800, 1250]) {
      expect(perspFar(d), `${d}mm`).toBe(FAR_AT_REST);
      expect(perspFar(d)).toBe(OLD_FAR);
    }
  });

  it("only starts moving once the fixed plane would have been too close", () => {
    expect(perspFar(FAR_AT_REST / FAR_FACTOR - 1)).toBe(FAR_AT_REST);
    expect(perspFar(FAR_AT_REST / FAR_FACTOR + 1)).toBeGreaterThan(FAR_AT_REST);
  });

  it("keeps the whole ground grid inside the frustum, at every zoom", () => {
    // The regression that matters. Before the fix this failed from a ~200mm grid
    // step onward, which is exactly where the lattice was reported as breaking up.
    for (const [w, h] of VIEWPORTS) {
      for (let d = 1; d < 5e5; d *= 1.3) {
        const need = d + gridReach(d, w, h);
        expect(perspFar(d), `${w}x${h} at ${d.toFixed(0)}mm`).toBeGreaterThan(need);
      }
    }
  });

  it("is exactly the case the old fixed plane failed", () => {
    // The two measurements from the running app, as a guard against anyone
    // "simplifying" this back to a constant.
    for (const [dist, reach] of [[2813, 8000], [13054, 37500]] as const) {
      expect(OLD_FAR).toBeLessThan(dist + reach); // it really was clipped
      expect(perspFar(dist)).toBeGreaterThan(dist + reach);
    }
  });

  it("never brings the far plane inward as the camera goes out", () => {
    let prev = 0;
    for (let d = 1e-3; d < 1e6; d *= 1.4) {
      const f = perspFar(d);
      expect(f, `${d}mm`).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it("spends depth precision only where nothing can see it", () => {
    // far/near is what depth precision costs, and near stops growing at 0.1mm,
    // so past ~1.25m out the ratio really does grow with the distance. Pin what
    // that buys and what it costs: every view where a user could SEE depth
    // precision keeps the old pair exactly, and the range only opens up at zooms
    // where the part is a couple of pixels across.
    const near = (d: number) => Math.min(0.1, Math.max(1e-4, d * 0.05));
    for (const d of [10, 120, 1200]) {
      expect(perspFar(d) / near(d), `${d}mm`).toBe(OLD_FAR / near(d));
    }
    expect(perspFar(13054) / near(13054)).toBeGreaterThan(OLD_FAR / near(13054));
  });

  it("answers a usable number for a degenerate distance", () => {
    for (const d of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = perspFar(d as number);
      expect(Number.isFinite(f), `${d}`).toBe(true);
      expect(f).toBeGreaterThanOrEqual(FAR_AT_REST);
    }
  });
});

describe("orthoDepth", () => {
  it("leaves ordinary sketch views on the old fixed range", () => {
    for (const halfH of [1, 50, 300]) expect(orthoDepth(halfH)).toBe(FAR_AT_REST);
  });

  it("covers the sketch grid rather than clipping it, zoomed out", () => {
    // Orthographic was left alone on the grounds that its precision does not
    // vary with zoom — true, and beside the point: the range was the same fixed
    // ±10000, so a zoomed-out sketch clipped its own lattice too.
    for (const [w, h] of VIEWPORTS) {
      for (let halfH = 1; halfH < 1e5; halfH *= 1.4) {
        const mmPerPx = (2 * halfH) / h;
        const cell = niceStep(mmPerPx * 64);
        const cells = groundGridCells(mmPerPx, Math.hypot(w, h), cell);
        const reach = (cell * cells * Math.SQRT2) / 2;
        expect(orthoDepth(halfH), `${w}x${h} halfH ${halfH.toFixed(0)}`).toBeGreaterThan(reach);
      }
    }
  });

  it("is symmetric about the camera by construction", () => {
    // The caller writes near = -depth, far = +depth, so geometry behind the eye
    // still draws. One number has to serve both ends.
    expect(orthoDepth(1000)).toBe(Math.max(FAR_AT_REST, 1000 * ORTHO_DEPTH_FACTOR));
  });

  it("answers a usable number for a degenerate frustum", () => {
    for (const h of [0, -5, Number.NaN]) {
      expect(orthoDepth(h as number)).toBe(FAR_AT_REST);
    }
  });
});
