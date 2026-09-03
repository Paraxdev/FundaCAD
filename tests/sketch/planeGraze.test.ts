import { describe, it, expect } from "vitest";
import { planeFacing, tooEdgeOn, MIN_PLANE_FACING } from "../../src/sketch/planeGraze";

/** The numbers in planeGraze.ts came off a measurement of where a click really
 *  landed as the view rolled the XY plane away (130mm standoff, 90px above the
 *  view centre). These lock the rule that came out of it. */

const Z = [0, 0, 1] as const;

/** A view direction `deg` degrees off the plane's normal. */
const off = (deg: number) => {
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), 0, Math.cos(r)] as const;
};

describe("how square-on a sketch plane is", () => {
  it("is 1 looking straight at the plane and 0 looking along it", () => {
    expect(planeFacing(Z, Z)).toBeCloseTo(1, 12);
    expect(planeFacing([1, 0, 0], Z)).toBeCloseTo(0, 12);
  });

  it("does not care which side of the plane the camera is on", () => {
    // Drawing on the back of a plane is as legitimate as the front, so the
    // measure is unsigned.
    expect(planeFacing([0, 0, -1], Z)).toBeCloseTo(1, 12);
    expect(planeFacing(off(150), Z)).toBeCloseTo(planeFacing(off(30), Z), 12);
  });

  it("does not depend on either vector's length", () => {
    expect(planeFacing([0, 0, 7], [0, 0, 0.001])).toBeCloseTo(1, 12);
    expect(planeFacing([3, 0, 4], Z)).toBeCloseTo(0.8, 12);
  });

  it("faces nothing when a vector has no direction at all", () => {
    // A degenerate camera or a null normal must read as edge-on rather than as
    // a NaN that compares false against every threshold and lets the click by.
    expect(planeFacing([0, 0, 0], Z)).toBe(0);
    expect(planeFacing(Z, [0, 0, 0])).toBe(0);
    expect(tooEdgeOn([0, 0, 0], Z)).toBe(true);
  });
});

describe("when a click is declined", () => {
  it("allows a plane the user is looking at", () => {
    // The control for every refusal below: an ordinary sketching camera, square
    // on and well off square, has to keep working.
    expect(tooEdgeOn(Z, Z)).toBe(false);
    expect(tooEdgeOn(off(45), Z)).toBe(false);
    expect(tooEdgeOn(off(75), Z)).toBe(false);
  });

  it("declines the cameras that put the point off the side of the world", () => {
    // 89.94 degrees is where the measurement landed 12 metres out, and exactly
    // edge-on is where it landed 1.35 km out.
    expect(tooEdgeOn(off(89.94), Z)).toBe(true);
    expect(tooEdgeOn(off(90), Z)).toBe(true);
    expect(tooEdgeOn([1, 0, 0], Z)).toBe(true);
  });

  it("turns over within a degree of the stated threshold", () => {
    const edge = (90 - (Math.acos(MIN_PLANE_FACING) * 180) / Math.PI);
    expect(edge).toBeCloseTo(5.74, 2);
    expect(tooEdgeOn(off(90 - edge - 0.01), Z)).toBe(false);
    expect(tooEdgeOn(off(90 - edge + 0.01), Z)).toBe(true);
  });

  it("takes a caller's own threshold", () => {
    expect(tooEdgeOn(off(80), Z)).toBe(false);
    expect(tooEdgeOn(off(80), Z, 0.5)).toBe(true);
  });

  it("judges a tilted plane by its own normal, not by the world axes", () => {
    // A datum plane at 45 degrees, viewed straight down its own normal, is as
    // face-on as XY is from above; viewed down world Z it is not.
    const n = [0, Math.SQRT1_2, Math.SQRT1_2] as const;
    expect(tooEdgeOn(n, n)).toBe(false);
    expect(planeFacing(Z, n)).toBeCloseTo(Math.SQRT1_2, 12);
    const along = [0, Math.SQRT1_2, -Math.SQRT1_2] as const;
    expect(tooEdgeOn(along, n)).toBe(true);
  });
});
