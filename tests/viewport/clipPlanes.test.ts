// The near plane that follows the camera in, and the zoom floor it lifts.

import { describe, expect, it } from "vitest";
import {
  MIN_PERSP_DIST,
  NEAR_AT_REST,
  NEAR_FLOOR,
  NEAR_FRACTION,
  perspNear,
} from "../../src/viewport/clipPlanes";

/** The pair this replaced: a fixed near, and a floor five times it. */
const OLD_NEAR = 0.1;
const OLD_MIN_DIST = 0.5;

describe("perspNear", () => {
  it("leaves every ordinary view exactly where it was", () => {
    // The safety property. Anything the user is likely to be looking at — a
    // part framed, a detail examined, a whole assembly — is metres from this
    // rule's reach, and gets the same 0.1 it always did.
    for (const d of [2, 5, 20, 120, 500, 3000, 9000]) {
      expect(perspNear(d), `${d}mm`).toBe(OLD_NEAR);
    }
    expect(NEAR_AT_REST).toBe(OLD_NEAR);
  });

  it("keeps the surface well in front of near at any distance", () => {
    // What near is FOR. The old pair's worst case was distance/near = 5, at its
    // floor; this may never do worse than that anywhere in its range.
    for (let d = MIN_PERSP_DIST; d < 10000; d *= 1.2) {
      expect(d / perspNear(d), `${d}mm`).toBeGreaterThanOrEqual(5);
    }
  });

  it("has more headroom at its floor than the old pair had at theirs", () => {
    expect(MIN_PERSP_DIST / perspNear(MIN_PERSP_DIST)).toBeGreaterThan(OLD_MIN_DIST / OLD_NEAR);
  });

  it("lets the camera get materially closer than it could", () => {
    // The defect, stated as a number: the app parked at 0.5mm however long you
    // wheeled. This is the control for that measurement.
    expect(MIN_PERSP_DIST).toBeLessThan(OLD_MIN_DIST);
    expect(OLD_MIN_DIST / MIN_PERSP_DIST).toBeGreaterThanOrEqual(20);
  });

  it("never returns a near plane of zero or below", () => {
    // A near of 0 makes the projection matrix singular and the whole view goes
    // blank, which is why the floor is not merely a precision preference.
    for (const d of [MIN_PERSP_DIST, 1e-6, 1e-12, 0, -3, NaN, Infinity]) {
      const n = perspNear(d);
      expect(n, `${d}`).toBeGreaterThan(0);
      expect(Number.isFinite(n), `${d}`).toBe(true);
      expect(n).toBeGreaterThanOrEqual(NEAR_FLOOR);
    }
  });

  it("is the stated fraction wherever neither clamp is biting", () => {
    for (const d of [0.01, 0.05, 0.4, 1.5]) {
      expect(perspNear(d), `${d}mm`).toBeCloseTo(d * NEAR_FRACTION, 12);
    }
  });

  it("never moves the near plane outward as the camera comes in", () => {
    let prev = 0;
    for (let d = 10000; d > 1e-6; d /= 1.3) {
      const n = perspNear(d);
      if (prev) expect(n, `${d}mm`).toBeLessThanOrEqual(prev);
      prev = n;
    }
  });
});
