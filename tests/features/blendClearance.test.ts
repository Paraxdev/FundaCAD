import { describe, it, expect } from "vitest";
import {
  CLEARANCE_SHARE,
  boxDistanceSq,
  clearanceLimit,
  closedLoopRadius,
  localClearance,
  polylineBox,
  polylineDistance,
  segmentDistanceSq,
  touchTolerance,
  type ClearanceEdge,
  type Pt3,
} from "../../src/features/blendClearance";

const p = (x: number, y: number, z: number): Pt3 => [x, y, z];

/** The 12 edges of an axis-aligned box, in the polyline form the viewport
 *  stores. Every test case below is some box, because a box is the shape whose
 *  correct answer nobody can argue about: a blend on any edge of a cube of side
 *  s can reach s/2 and no further. */
function boxEdges(sx: number, sy: number, sz: number): ClearanceEdge[] {
  const xs = [0, sx];
  const ys = [0, sy];
  const zs = [0, sz];
  const out: ClearanceEdge[] = [];
  let n = 0;
  for (const y of ys)
    for (const z of zs) out.push({ id: `x${n++}`, points: [p(0, y, z), p(sx, y, z)] });
  for (const x of xs)
    for (const z of zs) out.push({ id: `y${n++}`, points: [p(x, 0, z), p(x, sy, z)] });
  for (const x of xs)
    for (const y of ys) out.push({ id: `z${n++}`, points: [p(x, y, 0), p(x, y, sz)] });
  return out;
}

/** Fetch by index, loudly. A silent `undefined` slipping into `selected` would
 *  make localClearance return null and every assertion below pass vacuously. */
function at<T>(xs: readonly T[], i: number): T {
  const v = xs[i];
  if (v === undefined) throw new Error(`no element ${i} of ${xs.length}`);
  return v;
}

describe("segmentDistanceSq", () => {
  it("measures skew, parallel and crossing segments", () => {
    // skew: the two unit segments on opposite faces of a unit gap
    expect(segmentDistanceSq(p(0, 0, 0), p(1, 0, 0), p(0, 0, 2), p(0, 1, 2))).toBeCloseTo(4);
    // parallel: the general-case denominator is exactly 0 here, so this is the
    // branch that returns NaN if the parallel guard is dropped.
    expect(segmentDistanceSq(p(0, 0, 0), p(1, 0, 0), p(0, 3, 0), p(1, 3, 0))).toBeCloseTo(9);
    // crossing at a point
    expect(segmentDistanceSq(p(-1, 0, 0), p(1, 0, 0), p(0, -1, 0), p(0, 1, 0))).toBeCloseTo(0);
  });

  it("clamps to the endpoints rather than extending the lines", () => {
    // Infinite lines would intersect; the segments stop short. Reading the
    // unclamped answer would report a clearance of 0 for two edges that never
    // come near each other, and refuse every blend on that edge.
    expect(segmentDistanceSq(p(0, 0, 0), p(1, 0, 0), p(5, -1, 0), p(5, 1, 0))).toBeCloseTo(16);
  });

  it("survives zero-length segments", () => {
    // A tessellated curve routinely repeats a point at a cusp or a seam. Both
    // degenerate branches produce a 0 denominator in the general case.
    expect(segmentDistanceSq(p(0, 0, 0), p(0, 0, 0), p(3, 0, 0), p(3, 0, 0))).toBeCloseTo(9);
    expect(segmentDistanceSq(p(0, 0, 0), p(0, 0, 0), p(3, 0, 0), p(3, 4, 0))).toBeCloseTo(9);
    expect(segmentDistanceSq(p(0, 0, 0), p(4, 0, 0), p(2, 5, 0), p(2, 5, 0))).toBeCloseTo(25);
  });
});

describe("boxDistanceSq", () => {
  it("is zero for overlapping boxes and the gap otherwise", () => {
    const a = { min: [0, 0, 0], max: [1, 1, 1] } as const;
    expect(boxDistanceSq({ ...a, min: [...a.min], max: [...a.max] }, { min: [0.5, 0.5, 0.5], max: [2, 2, 2] })).toBe(0);
    expect(boxDistanceSq({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [4, 0, 0], max: [5, 1, 1] })).toBeCloseTo(9);
  });

  it("never exceeds the true distance between the contents", () => {
    // The whole point of the box test is that it is a LOWER bound: reject on it
    // and you can never discard a pair that would have won. A box distance that
    // overshot would silently drop the nearest neighbour.
    const a: Pt3[] = [p(0, 0, 0), p(1, 1, 0)];
    const b: Pt3[] = [p(4, 0, 0), p(5, 1, 0)];
    const boxA = polylineBox(a)!;
    const boxB = polylineBox(b)!;
    expect(Math.sqrt(boxDistanceSq(boxA, boxB))).toBeLessThanOrEqual(polylineDistance(a, b) + 1e-9);
  });
});

describe("polylineDistance", () => {
  it("finds the closest approach anywhere along either polyline", () => {
    // The nearest pair is an interior segment of each, not an endpoint, a
    // measure that only compared endpoints would report 5 instead of 1.
    const a: Pt3[] = [p(0, 0, 0), p(0, 5, 0), p(0, 10, 0)];
    const b: Pt3[] = [p(1, 10, 0), p(1, 5, 0), p(1, 0, 0)];
    expect(polylineDistance(a, b)).toBeCloseTo(1);
  });

  it("is Infinity when a polyline has no segment to measure", () => {
    expect(polylineDistance([p(0, 0, 0)], [p(1, 0, 0), p(2, 0, 0)])).toBe(Infinity);
    expect(polylineDistance([], [])).toBe(Infinity);
  });

  it("returns the true distance when the running best does not exclude it", () => {
    const a: Pt3[] = [p(0, 0, 0), p(1, 0, 0)];
    const b: Pt3[] = [p(0, 3, 0), p(1, 3, 0)];
    expect(polylineDistance(a, b, Infinity)).toBeCloseTo(3);
    expect(polylineDistance(a, b, 100)).toBeCloseTo(3); // 100 > 3^2, still admits it
  });
});

describe("localClearance", () => {
  it("ignores the edges that share a vertex with the pick", () => {
    // Every edge of a cube touches four others at a corner. If those counted,
    // the clearance would be 0 and the tool would refuse every blend on every
    // edge of every part, the failure this whole tolerance exists to prevent.
    const all = boxEdges(10, 10, 10);
    const c = localClearance({ selected: [at(all, 0)], all, modelScale: 17.3 });
    expect(c).toBeCloseTo(10);
  });

  it("reads the thin direction of a plate, not its overall size", () => {
    // 100 x 100 x 2. The old global bound (a quarter of the 141mm diagonal)
    // allowed a 35mm fillet on a 2mm rim: every value past 1mm was a certain
    // failure the user had to discover by dragging into it.
    const all = boxEdges(100, 100, 2);
    const rim = all.find((e) => e.id === "x0")!; // a long edge of the thin plate
    const c = localClearance({ selected: [rim], all, modelScale: Math.hypot(100, 100, 2) })!;
    expect(c).toBeCloseTo(2);
    expect(clearanceLimit(c)).toBeCloseTo(1);
  });

  it("grows the bound on a chunky part instead of holding it back", () => {
    // The same global fraction was too TIGHT here: 0.25 x the 346mm diagonal
    // stopped at 86mm on a part that takes 100. Both complaints were the one
    // bug, a global number standing in for a local one.
    const all = boxEdges(200, 200, 200);
    const c = localClearance({ selected: [at(all, 0)], all, modelScale: Math.hypot(200, 200, 200) })!;
    expect(clearanceLimit(c)).toBeCloseTo(100);
    expect(clearanceLimit(c)!).toBeGreaterThan(346 * 0.25);
  });

  it("takes the tightest clearance across a multi-edge selection", () => {
    // Picking a whole tangent chain applies ONE radius to all of it, so the
    // narrowest neighbourhood in the set is what the drag has to respect.
    const all = boxEdges(40, 40, 3);
    const thin = all.find((e) => e.id === "x0")!;
    const chunky = all.find((e) => e.id === "z8")!;
    const both = localClearance({ selected: [thin, chunky], all, modelScale: 57 })!;
    expect(both).toBeCloseTo(3);
  });

  it("hands the decision back rather than inventing a number", () => {
    // Null means "not measured" and the caller keeps its global bound. An
    // Infinity here would read as "measured: unbounded" and remove the clamp
    // altogether, which is the one outcome worse than a crude clamp.
    const all = boxEdges(10, 10, 10);
    expect(localClearance({ selected: [], all, modelScale: 17 })).toBeNull();
    expect(localClearance({ selected: [at(all, 0)], all: [], modelScale: 17 })).toBeNull();
    // a lone edge, with nothing else in the document to be near
    expect(localClearance({ selected: [at(all, 0)], all: [at(all, 0)], modelScale: 17 })).toBeNull();
  });

  it("is unmoved by the order the edges arrive in", () => {
    // The running-best rejection prunes pairs as it goes, so a wrong bound test
    // would give different answers for different orderings, and the ordering
    // here is whatever the tessellation happened to emit.
    const all = boxEdges(30, 12, 7);
    const pick = at(all, 0);
    const fwd = localClearance({ selected: [pick], all, modelScale: 33 });
    const rev = localClearance({ selected: [pick], all: [...all].reverse(), modelScale: 33 });
    expect(rev).toBeCloseTo(fwd!);
  });
});

/** A closed circle of radius r in the z = h plane, tessellated the way the
 *  sidecar emits one: n samples with the last point repeating the first. */
function circle(r: number, h: number, n = 48): Pt3[] {
  const pts: Pt3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(p(r * Math.cos(a), r * Math.sin(a), h));
  }
  return pts;
}

describe("closedLoopRadius", () => {
  it("reads a tessellated circle's own radius", () => {
    expect(closedLoopRadius(circle(7, 0))).toBeCloseTo(7, 1);
  });

  it("is null for an open polyline, which has no turning limit", () => {
    expect(closedLoopRadius([p(0, 0, 0), p(1, 0, 0), p(2, 0, 0)])).toBeNull();
    expect(closedLoopRadius([p(0, 0, 0), p(1, 0, 0)])).toBeNull();
  });
});

describe("localClearance on a cylinder", () => {
  it("caps a rim by its own radius, not by the distance to the far rim", () => {
    // A tall thin cylinder: r = 5, h = 80. The bottom rim is 80mm away, so a
    // neighbour-distance measure alone would offer 40mm of travel on a rim whose
    // fillet runs out of cap at 5. This is the case the sidecar's reference
    // measure caps for the same reason, and the one where "it overshoots" is not
    // about thin walls at all.
    const top = { id: "top", points: circle(5, 80) };
    const bottom = { id: "bottom", points: circle(5, 0) };
    const c = localClearance({ selected: [top], all: [top, bottom], modelScale: 80 })!;
    expect(c).toBeCloseTo(5, 1);
  });

  it("still lets a neighbour tighten the bound below that radius", () => {
    // A wide flat disc: r = 40 but only 2mm thick. The cap no longer decides,
    // the far face does, and the tighter of the two has to win.
    const top = { id: "top", points: circle(40, 2) };
    const bottom = { id: "bottom", points: circle(40, 0) };
    const c = localClearance({ selected: [top], all: [top, bottom], modelScale: 80 })!;
    expect(c).toBeCloseTo(2, 1);
  });
});

describe("touchTolerance", () => {
  it("scales with the model so it means the same thing at any size", () => {
    // A fixed absolute tolerance would treat a real 0.001mm gap on a 400mm plate
    // as a shared vertex, and a genuinely shared vertex on a 0.5mm part as a
    // neighbour 0.5mm away.
    expect(touchTolerance(400)).toBeGreaterThan(touchTolerance(6));
    expect(touchTolerance(0)).toBeGreaterThan(0);
    expect(touchTolerance(Number.NaN)).toBeGreaterThan(0);
  });
});

describe("clearanceLimit", () => {
  it("gives each side of a gap half of it", () => {
    expect(clearanceLimit(8)).toBeCloseTo(8 * CLEARANCE_SHARE);
  });

  it("refuses to turn a non-measurement into a bound", () => {
    expect(clearanceLimit(null)).toBeNull();
    expect(clearanceLimit(0)).toBeNull();
    expect(clearanceLimit(Number.NaN)).toBeNull();
    expect(clearanceLimit(Infinity)).toBeNull();
  });
});
