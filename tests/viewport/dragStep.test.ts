// The drag lattice, and the defect it was: a whole millimetre per step.

import { describe, expect, it } from "vitest";
import {
  DRAG_GRANULARITY_PX,
  FINE_DIVISOR,
  MIN_STEP,
  dragStep,
} from "../../src/viewport/dragStep";
import { niceStep, snap } from "../../src/ui/units";

/** What the rule used to be, kept as the control. Every claim below about the
 *  defect is checked against this and not against a remembered number. */
const OLD_RULE = (worldPerPixel: number) => niceStep(worldPerPixel * 8);

/** World mm per screen pixel with a 60mm part fitted in a 900px viewport,
 *  measured on the running app rather than derived here. */
const FITTED = 0.14349;

describe("dragStep", () => {
  it("gives a fitted hand-sized part a tenth of a millimetre", () => {
    expect(dragStep(FITTED)).toBe(0.1);
  });

  it("the old rule gave that same part a whole millimetre", () => {
    // The control. If this ever stops holding, the measurement above no longer
    // describes the defect and the numbers in dragStep.ts need re-taking.
    expect(OLD_RULE(FITTED)).toBe(1);
  });

  it("follows the zoom in both directions", () => {
    // Wheeling in ten notches at 0.8 per notch is about a tenth of the world
    // per pixel, and the step follows it down by the same decade.
    expect(dragStep(FITTED)).toBe(0.1);
    expect(dragStep(FITTED / 10)).toBe(0.01);
    expect(dragStep(FITTED / 100)).toBe(0.001);
    expect(dragStep(FITTED * 10)).toBe(1);
    expect(dragStep(FITTED * 100)).toBe(10);
  });

  it("keeps every step a legible number", () => {
    // The whole reason for rounding at all: a drag readout of 12.3 rather than
    // 12.34567. Every step is 1, 2 or 5 times a power of ten.
    for (let e = -3; e <= 3; e++) {
      for (const b of [1, 1.3, 2.7, 4, 6, 9]) {
        const step = dragStep(b * 10 ** e);
        const mantissa = step / 10 ** Math.round(Math.log10(step) - 0.5 + 1e-9);
        expect([1, 2, 5, 10]).toContain(Math.round(mantissa * 1000) / 1000);
      }
    }
  });

  it("stays roughly one pixel per step at any zoom", () => {
    // The property the granularity constant states. niceStep rounds, so the
    // ratio wanders around DRAG_GRANULARITY_PX rather than sitting on it, but
    // it may never wander far enough to be a different kind of gesture.
    for (const wpp of [0.002, 0.01, 0.0731, 0.14349, 0.5, 1, 3.3, 12]) {
      const px = dragStep(wpp) / wpp;
      expect(px, `world/px ${wpp}`).toBeGreaterThan(DRAG_GRANULARITY_PX * 0.5);
      expect(px, `world/px ${wpp}`).toBeLessThan(DRAG_GRANULARITY_PX * 1.6);
    }
  });

  it("is finer with Shift, by exactly the stated divisor", () => {
    for (const wpp of [0.14349, 0.01, 1.7]) {
      expect(dragStep(wpp, true)).toBeCloseTo(dragStep(wpp) / FINE_DIVISOR, 12);
    }
  });

  it("never offers a step that snap() would round away", () => {
    // The floor is not a taste call. snap() rounds through round(), which
    // quantises to 0.001, so a lattice finer than that is not a finer drag —
    // it is a drag that stops responding. Two neighbouring lattice points must
    // still be two distinct values after snapping.
    for (const wpp of [1e-9, 1e-6, 1e-5, 1e-4, 5e-4]) {
      for (const fine of [false, true]) {
        const step = dragStep(wpp, fine);
        expect(step, `world/px ${wpp}${fine ? " fine" : ""}`).toBeGreaterThanOrEqual(MIN_STEP);
        expect(snap(step, step)).not.toBe(snap(2 * step, step) - step + 1e-9);
        expect(snap(2 * step, step)).toBeGreaterThan(snap(step, step));
      }
    }
  });

  it("survives a zoom that is not a number", () => {
    // pixelWorldSize divides by a rect height, and a canvas that has not been
    // laid out yet has none.
    expect(dragStep(0)).toBe(MIN_STEP);
    expect(dragStep(-1)).toBe(MIN_STEP);
    expect(dragStep(NaN)).toBe(MIN_STEP);
    expect(dragStep(Infinity)).toBe(MIN_STEP);
  });

  it("is monotonic in the zoom", () => {
    // Zooming in may never make the drag coarser. Cheap to state, and the kind
    // of thing a clamp added later would quietly break.
    let prev = 0;
    for (let i = 0; i < 200; i++) {
      const step = dragStep(1e-4 * 1.1 ** i);
      expect(step).toBeGreaterThanOrEqual(prev);
      prev = step;
    }
  });
});
