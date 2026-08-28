// Aiming at a point on the model.
//
// The thing worth pinning is the ORDER: under a 10px reach several candidates
// are usually available at once, and which one wins is the whole behaviour. The
// control for each rule is the same case with the rule's own candidate removed.

import { describe, expect, it } from "vitest";
import {
  pickPoint,
  polylineMidpoint3,
  POINT_SNAP_PX,
  type PointCandidate,
} from "../../src/viewport/pointSnap";

/** A projection that simply drops z, so a candidate's screen place is readable
 *  straight off its coordinates. */
const flat = (p: readonly [number, number, number]) => ({ x: p[0], y: p[1] });
const at = (x: number, y: number) => ({ x, y });
const cand = (x: number, y: number, kind: PointCandidate["kind"]): PointCandidate =>
  ({ p: [x, y, 0], kind });

describe("pickPoint", () => {
  it("prefers a corner to the surface it sits on", () => {
    const cs = [cand(100, 100, "surface"), cand(105, 103, "vertex")];
    expect(pickPoint(cs, flat, at(100, 100))?.kind).toBe("vertex");
    // CONTROL: with no corner in reach, the surface point is the answer rather
    // than nothing — aiming at the middle of a large face has to land on it.
    expect(pickPoint([cs[0] as PointCandidate], flat, at(100, 100))?.kind).toBe("surface");
  });

  it("ranks corner over edge middle over face centre", () => {
    const all = [
      cand(103, 100, "center"),
      cand(102, 100, "midpoint"),
      cand(106, 100, "vertex"),
    ];
    expect(pickPoint(all, flat, at(100, 100))?.kind).toBe("vertex");
    expect(pickPoint(all.slice(0, 2), flat, at(100, 100))?.kind).toBe("midpoint");
    expect(pickPoint(all.slice(0, 1), flat, at(100, 100))?.kind).toBe("center");
  });

  it("takes the nearer of two of the same kind", () => {
    const cs = [cand(107, 100, "vertex"), cand(101, 100, "vertex")];
    expect(pickPoint(cs, flat, at(100, 100))?.p[0]).toBe(101);
  });

  it("has a reach, and it is the same at every zoom because it is in pixels", () => {
    expect(pickPoint([cand(100 + POINT_SNAP_PX, 100, "vertex")], flat, at(100, 100))).not.toBeNull();
    expect(pickPoint([cand(100 + POINT_SNAP_PX + 1, 100, "vertex")], flat, at(100, 100))).toBeNull();
  });

  it("skips a candidate that cannot be projected", () => {
    // Behind the camera. Guessing at where it would have been is how a gizmo
    // ends up snapping to a corner that is not on screen.
    const behind = (): null => null;
    expect(pickPoint([cand(100, 100, "vertex")], behind, at(100, 100))).toBeNull();
    const nan = () => ({ x: NaN, y: NaN });
    expect(pickPoint([cand(100, 100, "vertex")], nan, at(100, 100))).toBeNull();
  });

  it("has nothing to say when nothing is near", () => {
    expect(pickPoint([], flat, at(0, 0))).toBeNull();
    expect(pickPoint([cand(500, 500, "vertex")], flat, at(0, 0))).toBeNull();
  });
});

describe("polylineMidpoint3", () => {
  it("is half way along the curve, not along the chord", () => {
    const quarter: [number, number, number][] = [];
    for (let i = 0; i <= 32; i++) {
      const t = (Math.PI / 2) * (i / 32);
      quarter.push([10 * Math.cos(t), 10 * Math.sin(t), 0]);
    }
    const m = polylineMidpoint3(quarter)!;
    expect(Math.hypot(m[0], m[1])).toBeCloseTo(10, 2);
    // CONTROL: the chord midpoint is 2.9mm inside the arc on a 10mm radius.
    const a = quarter[0]!;
    const b = quarter[quarter.length - 1]!;
    expect(Math.hypot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)).toBeLessThan(7.2);
  });

  it("is the middle of a straight edge however densely it is sampled", () => {
    expect(polylineMidpoint3([[0, 0, 0], [10, 0, 0]])![0]).toBeCloseTo(5, 9);
    expect(polylineMidpoint3([[0, 0, 0], [1, 0, 0], [9, 0, 0], [10, 0, 0]])![0]).toBeCloseTo(5, 9);
  });

  it("refuses a run with no length", () => {
    // A closed edge's ends coincide; its "middle" would be a snap target at
    // wherever the kernel put the seam.
    expect(polylineMidpoint3([[2, 2, 2], [2, 2, 2]])).toBeNull();
    expect(polylineMidpoint3([[1, 1, 1]])).toBeNull();
  });
});
