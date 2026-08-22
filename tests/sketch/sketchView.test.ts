import { describe, it, expect } from "vitest";
import {
  faceSketchPlane,
  outwardNormal,
  sketchLockHolds,
  SQUARE_TOL_DEG,
  viewSquareToPlane,
  sketchXdir,
  sketchYdir,
  VIEW_RELEASE_FACTOR,
  type Vec3,
} from "../../src/sketch/sketchView";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const close = (a: Vec3, b: Vec3, digits = 9) => {
  for (let i = 0; i < 3; i++) expect(a[i]!).toBeCloseTo(b[i]!, digits);
};
/** A spread of unit normals covering every octant, including the awkward
 *  near-45° ones where two world axes compete for "most aligned". */
const SPREAD: Vec3[] = [];
for (let a = 0; a < Math.PI * 2; a += Math.PI / 7) {
  for (let b = -1.4; b <= 1.4; b += 0.35) {
    SPREAD.push([Math.cos(a) * Math.cos(b), Math.sin(a) * Math.cos(b), Math.sin(b)]);
  }
}

describe("sketchXdir", () => {
  it("reproduces the base-plane bases on the cardinal faces", () => {
    // A top face should sketch like the XY plane and a +X face like YZ — anything
    // else and "sketch on this face" would feel rotated relative to the datum
    // sketch a user already knows.
    close(sketchXdir([0, 0, 1]), [1, 0, 0]);
    close(sketchYdir({ origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] }), [0, 1, 0]);
    close(sketchXdir([1, 0, 0]), [0, 1, 0]);
    close(sketchYdir({ origin: [0, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0] }), [0, 0, 1]);
  });

  it("is a unit vector lying in the plane, for every orientation", () => {
    for (const n of SPREAD) {
      const u = sketchXdir(n);
      expect(Math.hypot(u[0], u[1], u[2])).toBeCloseTo(1, 9);
      expect(dot(u, n)).toBeCloseTo(0, 9);
    }
  });

  it("is deterministic — the same normal always gives the same axis", () => {
    // The whole point. A u derived from the camera, the click point or a
    // previous session would rotate the sketch's coordinates under the user
    // between two invocations on the SAME face.
    for (const n of SPREAD) expect(sketchXdir(n)).toEqual(sketchXdir(n));
  });

  it("does not spin as the face tilts", () => {
    // Sweep a normal a full turn around +Z at a shallow tilt and watch the axis
    // move continuously with it. The old rule switched reference axis at a fixed
    // |n.z| threshold, so two faces a degree apart could get bases 90° apart;
    // here the only switch is the dominant-component tie, which this sweep
    // (dominated by Z throughout) never reaches.
    const at = (a: number): Vec3 => [Math.cos(a) * 0.2, Math.sin(a) * 0.2, Math.sqrt(1 - 0.04)];
    let prev = sketchXdir(at(0));
    let worst = 0;
    for (let a = 0.01; a < Math.PI * 2; a += 0.01) {
      const u = sketchXdir(at(a));
      worst = Math.max(worst, Math.hypot(u[0] - prev[0], u[1] - prev[1], u[2] - prev[2]));
      prev = u;
    }
    expect(worst).toBeLessThan(0.05); // a switch of reference axis would be ~1.4
  });

  it("survives a degenerate normal", () => {
    const u = sketchXdir([0, 0, 0]);
    expect(Math.hypot(u[0], u[1], u[2])).toBeCloseTo(1, 9);
  });
});

describe("outwardNormal", () => {
  it("leaves a normal that already points away from the material alone", () => {
    expect(outwardNormal([0, 0, 1], [0, 0, 10], [0, 0, 0])).toEqual([0, 0, 1]);
  });

  it("flips a normal that points into the material", () => {
    // A reversed-winding import: the triangle normal aims back at the body, so
    // the sketch's +Z (and the first extrude off it) would go the wrong way.
    close(outwardNormal([0, 0, -1], [0, 0, 10], [0, 0, 0]), [0, 0, 1]);
  });

  it("trusts the normal when no interior reference is offered", () => {
    // The face-pick path passes null on purpose: the tessellation winding is
    // already exact, and a centre test would invert the underside of an overhang.
    expect(outwardNormal([0, 0, -1], [0, 0, 10], null)).toEqual([0, 0, -1]);
  });

  it("keeps the normal when the reference point IS the anchor", () => {
    expect(outwardNormal([0, 1, 0], [4, 4, 4], [4, 4, 4])).toEqual([0, 1, 0]);
  });
});

describe("faceSketchPlane", () => {
  it("keeps the face's own normal — it never inverts an outward one", () => {
    for (const n of SPREAD) close(faceSketchPlane(n, [3, -2, 7]).normal as Vec3, n);
  });

  it("hands back a right-handed basis with the normal out of the solid", () => {
    // SketchPlane derives v = n × u, so u × v must come back as n. If it came
    // back as −n every sketch on a face would be mirrored.
    for (const n of SPREAD) {
      const p = faceSketchPlane(n, [1, 1, 1]);
      close(cross(p.xdir as Vec3, sketchYdir(p)), n);
    }
  });

  it("flips to outward when told which side the material is on", () => {
    const p = faceSketchPlane([0, 0, -1], [0, 0, 10], [0, 0, 0]);
    close(p.normal as Vec3, [0, 0, 1]);
    // and the basis is rebuilt around the flipped normal, still right-handed
    close(cross(p.xdir as Vec3, sketchYdir(p)), [0, 0, 1]);
  });

  it("anchors the origin on the world origin's projection, not the pick point", () => {
    // Grid snapping rounds in plane-local coordinates, so the origin decides
    // where the lattice falls. Two picks on the same face must produce the SAME
    // plane, or each sketch gets its own grid offset by a fraction of a mm.
    const a = faceSketchPlane([0, 0, 1], [3.4797, 1.0501, 10]);
    const b = faceSketchPlane([0, 0, 1], [-40, 25, 10]);
    expect(a).toEqual(b);
    expect(a.origin).toEqual([0, 0, 10]);
  });

  it("puts the origin ON the face's plane for a slanted face", () => {
    const n: Vec3 = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    const point: Vec3 = [2, 5, -1];
    const p = faceSketchPlane(n, point);
    expect(dot(p.origin as Vec3, n)).toBeCloseTo(dot(point, n), 9); // same plane
  });

  it("normalises a non-unit normal", () => {
    const p = faceSketchPlane([0, 0, 4], [0, 0, 2]);
    close(p.normal as Vec3, [0, 0, 1]);
    expect(p.origin).toEqual([0, 0, 2]);
  });

  it("is stable across invocations", () => {
    const n: Vec3 = [0.3, -0.7, 0.64];
    expect(faceSketchPlane(n, [1, 2, 3])).toEqual(faceSketchPlane(n, [1, 2, 3]));
  });
});

describe("sketchLockHolds", () => {
  it("holds at the framing the sketch opened at", () => {
    expect(sketchLockHolds(100, 100)).toBe(true);
  });

  it("holds through the small zoom people do while drawing", () => {
    expect(sketchLockHolds(100, 40)).toBe(true); // zoomed in
    expect(sketchLockHolds(100, 100 * (VIEW_RELEASE_FACTOR - 0.2))).toBe(true);
  });

  it("lets go once the view has pulled back to look at the part", () => {
    expect(sketchLockHolds(100, 100 * (VIEW_RELEASE_FACTOR + 0.2))).toBe(false);
  });

  it("holds when there is no baseline or no usable scale yet", () => {
    // Called before the camera has settled into the sketch view: holding is the
    // safe answer — releasing is what CHANGES the camera policy, and doing that
    // off a garbage reading would drop the user out of the plane view for no
    // reason at all.
    expect(sketchLockHolds(0, 500)).toBe(true);
    expect(sketchLockHolds(NaN, 500)).toBe(true);
    expect(sketchLockHolds(100, NaN)).toBe(true);
    expect(sketchLockHolds(100, 0)).toBe(true);
  });
});

describe("viewSquareToPlane", () => {
  const up = [0, 0, 1] as const;

  it("holds when looking straight down the plane", () => {
    expect(viewSquareToPlane([0, 0, -1], up)).toBe(true);
  });

  it("holds looking straight down it from BEHIND", () => {
    // Which side you are on is settled once, at entry (viewFlight.viewSideNormal).
    // Re-litigating it every frame would drop the flat projection the instant a
    // sketch was opened from the back of its plane.
    expect(viewSquareToPlane([0, 0, 1], up)).toBe(true);
  });

  it("lets go once the view has genuinely turned away", () => {
    const off = (deg: number) => {
      const r = (deg * Math.PI) / 180;
      return [Math.sin(r), 0, -Math.cos(r)] as const;
    };
    expect(viewSquareToPlane(off(SQUARE_TOL_DEG - 2), up)).toBe(true);
    expect(viewSquareToPlane(off(SQUARE_TOL_DEG + 2), up)).toBe(false);
    expect(viewSquareToPlane(off(60), up)).toBe(false);
  });

  it("is edge-on at 90 degrees, which is as far off square as it gets", () => {
    expect(viewSquareToPlane([1, 0, 0], up)).toBe(false);
  });

  it("does not care about magnitude", () => {
    expect(viewSquareToPlane([0, 0, -400], [0, 0, 0.001])).toBe(true);
  });

  it("assumes it still holds when there is nothing to measure", () => {
    // A zero view direction means the camera is at its own target — a transient
    // during a fit. Dropping the projection on it would flicker.
    expect(viewSquareToPlane([0, 0, 0], up)).toBe(true);
    expect(viewSquareToPlane([0, 0, -1], [0, 0, 0])).toBe(true);
  });
});
