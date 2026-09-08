// The two things that are silent when wrong: the sign sent to the kernel (a hole
// that shrinks when you drag it open), and where the resize stops being a resize.

import { describe, it, expect } from "vitest";
import {
  COLLAPSE_FRACTION,
  collapseDiameter,
  deltaForDiameter,
  radialDrag,
} from "../../src/features/radialDrag";

describe("radialDrag", () => {
  it("reads the drag as a diameter, not a radius", () => {
    // A 10mm shaft (r=5) pulled 1mm outward is 12 across, not 11.
    expect(radialDrag(5, 1, true).diameter).toBeCloseTo(12);
    expect(radialDrag(5, 0, true).diameter).toBeCloseTo(10);
    expect(radialDrag(5, -1, true).diameter).toBeCloseTo(8);
  });

  it("pulls outward = bigger, on a bore as well as a boss", () => {
    // The handle points away from the axis in both cases, so the DIAMETER must
    // agree in both cases. Only the kernel's sign differs.
    expect(radialDrag(5, 1.5, true).diameter).toBeCloseTo(radialDrag(5, 1.5, false).diameter);
  });

  it("flips the kernel's sign for a bore", () => {
    // A press/pull distance moves the face along its own outward normal, which
    // points at the axis on a hole. Get this backwards and a hole dragged open
    // closes instead, no error, just the wrong part.
    expect(radialDrag(5, 1, true).distance).toBeCloseTo(1);
    expect(radialDrag(5, 1, false).distance).toBeCloseTo(-1);
    expect(radialDrag(5, -0.4, true).distance).toBeCloseTo(-0.4);
    expect(radialDrag(5, -0.4, false).distance).toBeCloseTo(0.4);
  });

  it("becomes a removal at the smallest size the kernel will build", () => {
    // The sidecar clamps an inward offset at 90% of the radius, so 10% is the
    // floor. Asking for less has to mean something other than "smaller".
    const r = 5;
    const floor = r * COLLAPSE_FRACTION;
    expect(radialDrag(r, -(r - floor) + 0.01, true).mode).toBe("resize");
    expect(radialDrag(r, -(r - floor), true).mode).toBe("remove");
    expect(radialDrag(r, -r, true).mode).toBe("remove"); // exactly zero
    expect(radialDrag(r, -r - 1, true).mode).toBe("remove"); // dragged past it
  });

  it("sends no distance while removing", () => {
    // Removal is a different feature (defeature/heal), not a very large push:
    // handing the kernel -6 on a 5mm radius is the collapse the clamp exists to
    // prevent, and it would come back clamped to -4.5, a resize nobody asked for.
    const d = radialDrag(5, -9, true);
    expect(d.mode).toBe("remove");
    expect(d.distance).toBe(0);
    expect(d.diameter).toBe(0);
  });

  it("is reversible: the same delta always reads the same, either direction", () => {
    // What makes the gesture safe to explore, crossing the floor and coming back
    // has to land on the number you left, or a slip of the mouse costs the size.
    const before = radialDrag(5, -1, true);
    radialDrag(5, -9, true); // through the floor
    expect(radialDrag(5, -1, true)).toEqual(before);
  });

  it("refuses a degenerate radius rather than inventing a size", () => {
    for (const r of [0, -1, NaN, Infinity]) expect(radialDrag(r, 1, true).mode).toBe("remove");
    expect(radialDrag(5, NaN, true).mode).toBe("remove");
  });

  it("round-trips a typed diameter through the drag", () => {
    for (const d of [12, 8, 1.5]) {
      expect(radialDrag(5, deltaForDiameter(5, d), true).diameter).toBeCloseTo(d, 9);
    }
    // typing 0 does what dragging to 0 does, and so does anything under the
    // floor, which is why the round trip above stays above it
    expect(radialDrag(5, deltaForDiameter(5, 0), true).mode).toBe("remove");
    expect(radialDrag(5, deltaForDiameter(5, 0.5), true).mode).toBe("remove");
  });

  it("reports the floor as a diameter, since that is what the readout speaks", () => {
    expect(collapseDiameter(5)).toBeCloseTo(1);
  });
});
