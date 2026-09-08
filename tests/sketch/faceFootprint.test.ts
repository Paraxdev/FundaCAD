import { describe, it, expect } from "vitest";
import { SketchPlane } from "../../src/sketch/plane";
import {
  edgeLiesInPlane,
  footprintCache,
  planeFootprint,
  planeTolerance,
  type FootprintEdge,
} from "../../src/sketch/faceFootprint";

/** The top face of a 20x20 box at z = 5: a sketch made on it lives in this
 *  plane, and the four edges below are that face's boundary. */
const topPlane = () =>
  new SketchPlane({ origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] });

const seg = (
  a: [number, number, number],
  b: [number, number, number],
): FootprintEdge => ({ points: [a, b] });

/** The rim of the top face, as four separate B-rep edges, which is how the
 *  viewport actually holds it. */
const topRim = (): FootprintEdge[] => [
  seg([-10, -10, 5], [10, -10, 5]),
  seg([10, -10, 5], [10, 10, 5]),
  seg([10, 10, 5], [-10, 10, 5]),
  seg([-10, 10, 5], [-10, -10, 5]),
];

/** The vertical edges of the same box: they touch the plane at one end only. */
const verticals = (): FootprintEdge[] => [
  seg([-10, -10, 5], [-10, -10, -5]),
  seg([10, -10, 5], [10, -10, -5]),
  seg([10, 10, 5], [10, 10, -5]),
  seg([-10, 10, 5], [-10, 10, -5]),
];

describe("edgeLiesInPlane", () => {
  it("accepts an edge whose every sample is on the plane", () => {
    expect(edgeLiesInPlane(topRim()[0]!, topPlane(), 1e-3)).toBe(true);
  });

  it("rejects an edge that only TOUCHES the plane at an end", () => {
    // A vertical edge of the box shares a vertex with the top face. If a shared
    // endpoint were enough, every edge of the body would be admitted and the
    // profile would be cut along lines that bound nothing.
    for (const v of verticals()) expect(edgeLiesInPlane(v, topPlane(), 1e-3)).toBe(false);
  });

  it("rejects an edge that CROSSES the plane", () => {
    // The dangerous case: both ends are off the plane, so a midpoint test would
    // pass it at the crossing while the edge is not in the plane at all.
    expect(edgeLiesInPlane(seg([0, 0, -5], [0, 0, 15]), topPlane(), 1e-3)).toBe(false);
  });

  it("rejects a degenerate edge with nothing to trace", () => {
    expect(edgeLiesInPlane({ points: [[0, 0, 5]] }, topPlane(), 1e-3)).toBe(false);
    expect(edgeLiesInPlane({ points: [] }, topPlane(), 1e-3)).toBe(false);
  });
});

describe("planeTolerance", () => {
  it("scales with the model so it means the same at any size", () => {
    // A fixed absolute tolerance would admit the face 0.05mm below on a 400mm
    // plate, and reject the real face on a 0.5mm part.
    expect(planeTolerance(400)).toBeGreaterThan(planeTolerance(6));
    expect(planeTolerance(0)).toBeGreaterThan(0);
    expect(planeTolerance(Number.NaN)).toBeGreaterThan(0);
  });
});

describe("planeFootprint", () => {
  it("returns the face outline as a closed loop, in sketch 2D", () => {
    const loops = planeFootprint([...topRim(), ...verticals()], topPlane(), 28);
    expect(loops).toHaveLength(1);
    const loop = loops[0]!;
    // the 20x20 rim, whatever winding and start vertex the tracer chose
    const xs = loop.map((p) => p.x);
    const ys = loop.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(-10, 6);
    expect(Math.max(...xs)).toBeCloseTo(10, 6);
    expect(Math.min(...ys)).toBeCloseTo(-10, 6);
    expect(Math.max(...ys)).toBeCloseTo(10, 6);
  });

  it("ignores geometry on a PARALLEL plane", () => {
    // The bottom face of the same box projects onto the top face's 2D frame
    // exactly, so without the distance gate a sketch on the top would be cut by
    // the outline of the bottom, indistinguishable from working, until the two
    // faces differ in shape.
    const bottom: FootprintEdge[] = [
      seg([-8, -8, -5], [8, -8, -5]),
      seg([8, -8, -5], [8, 8, -5]),
      seg([8, 8, -5], [-8, 8, -5]),
      seg([-8, 8, -5], [-8, -8, -5]),
    ];
    const loops = planeFootprint([...topRim(), ...bottom], topPlane(), 28);
    expect(loops).toHaveLength(1);
    const xs = loops[0]!.map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(10, 6); // the top rim, not the 8mm one
  });

  it("returns nothing when the plane has no model in it", () => {
    // A datum-plane sketch. The caller must pass this through as "no footprint",
    // not as "an empty face", or every profile on a datum plane reads as
    // unsupported.
    expect(planeFootprint(verticals(), topPlane(), 28)).toEqual([]);
    expect(planeFootprint([], topPlane(), 28)).toEqual([]);
  });

  it("finds a hole in the face as its own loop", () => {
    // A face with a bore has two boundaries, and the profile is unsupported over
    // the bore just as it is off the outer rim.
    const bore: FootprintEdge[] = [];
    const n = 24;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const b = ((i + 1) / n) * Math.PI * 2;
      bore.push(seg(
        [Math.cos(a) * 3, Math.sin(a) * 3, 5],
        [Math.cos(b) * 3, Math.sin(b) * 3, 5],
      ));
    }
    const loops = planeFootprint([...topRim(), ...bore], topPlane(), 28);
    expect(loops).toHaveLength(2);
  });
});

describe("footprintCache", () => {
  const source = (edges: FootprintEdge[], epoch: object) => {
    let walks = 0;
    const src = {
      edges: () => (walks++, edges),
      modelScale: () => 28,
      epoch: () => epoch,
    };
    return { src, walks: () => walks, retarget: (e: object) => (epoch = e) };
  };

  it("walks the model once per plane, not once per sketch", () => {
    // The committed overlay rebuilds every sketch on every document edit. Four
    // sketches on one plane over a 100k-edge assembly must not be four walks.
    const model = {};
    const { src, walks } = source(topRim(), model);
    const cache = footprintCache(src);
    const plane = topPlane();
    const a = cache(plane);
    const b = cache(plane);
    expect(walks()).toBe(1);
    expect(b).toBe(a); // the same array, not an equal one
  });

  it("walks each distinct plane separately", () => {
    const { src, walks } = source(topRim(), {});
    const cache = footprintCache(src);
    cache(topPlane());
    cache(topPlane()); // a different SketchPlane INSTANCE, same geometry
    expect(walks()).toBe(2);
  });

  it("re-walks when the model changes", () => {
    // The failure this guards is silent: a stale footprint keeps cutting a
    // profile along an edge the rebuild moved, and nothing looks wrong.
    const { src, walks, retarget } = source(topRim(), {});
    const cache = footprintCache(src);
    const plane = topPlane();
    cache(plane);
    expect(walks()).toBe(1);
    retarget({});
    cache(plane);
    expect(walks()).toBe(2);
  });

  it("does not re-walk when the model object is re-emitted unchanged", () => {
    // A visibility toggle re-emits the SAME result object. Keying on identity is
    // what makes hiding a body free here, as it already is in setModel.
    const model = {};
    const { src, walks } = source(topRim(), model);
    const cache = footprintCache(src);
    cache(topPlane());
    cache(topPlane());
    cache(topPlane());
    expect(walks()).toBe(3); // three planes
    const plane = topPlane();
    cache(plane);
    cache(plane);
    expect(walks()).toBe(4); // the fourth plane, walked once
  });

  it("serves an empty footprint from cache without re-walking", () => {
    // A datum-plane sketch has no model in its plane. That answer is as cacheable
    // as any other, and re-deriving it every edit is the expensive way to learn
    // nothing.
    const { src, walks } = source(verticals(), {});
    const cache = footprintCache(src);
    const plane = topPlane();
    expect(cache(plane)).toEqual([]);
    expect(cache(plane)).toEqual([]);
    expect(walks()).toBe(1);
  });
});
