import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { SketchPlane } from "../../src/sketch/plane";
import {
  faceFocus,
  edgeLiesInPlane,
  profileCutCache,
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

describe("profileCutCache", () => {
  type Line = [number, number, number][];
  type Box = { minx: number; miny: number; maxx: number; maxy: number };
  const rim: Line[] = topRim().map((e) => e.points.map((p) => [...p] as [number, number, number]));
  const need: Box = { minx: -5, miny: -5, maxx: 5, maxy: 5 };
  const source = (epoch: object, first: Line[] | null = rim) => {
    let landed = 0;
    let now = epoch;
    let doc: object = {};
    let answer = first;
    const reaches: Box[] = [];
    const pending: (() => void)[] = [];
    const src = {
      cuts: (_plane: unknown, reach: Box) => {
        reaches.push(reach);
        return new Promise<Line[] | null>((res) => pending.push(() => res(answer)));
      },
      epoch: () => now,
      document: () => doc,
      landed: () => void landed++,
    };
    const flush = async () => {
      for (const p of pending.splice(0)) p();
      await Promise.resolve();
      await Promise.resolve();
    };
    return {
      src, asks: () => reaches.length, reaches, landed: () => landed, flush,
      retarget: (e: object) => (now = e),
      open: () => (doc = {}),
      answer: (a: Line[] | null) => (answer = a),
    };
  };

  it("asks the engine once per plane per model and hands its lines back in sketch 2D", async () => {
    const s = source({});
    const cache = profileCutCache(s.src);
    const plane = topPlane();
    expect(cache(plane, need)).toEqual([]);
    expect(cache(plane, need)).toEqual([]);
    expect(s.asks()).toBe(1);
    await s.flush();
    expect(s.landed()).toBe(1);
    const lines = cache(plane, need);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual([new THREE.Vector2(-10, -10), new THREE.Vector2(10, -10)]);
    expect(s.asks()).toBe(1);
  });

  it("asks for more than the sketch covers, and again only once it outgrows that", async () => {
    const s = source({});
    const cache = profileCutCache(s.src);
    const plane = topPlane();
    cache(plane, need);
    await s.flush();
    const r = s.reaches[0]!;
    expect(r.minx).toBeLessThan(need.minx);
    expect(r.maxy).toBeGreaterThan(need.maxy);
    cache(plane, { minx: -6, miny: -6, maxx: 6, maxy: 6 });
    expect(s.asks()).toBe(1);
    const far = { minx: 100, miny: 100, maxx: 110, maxy: 110 };
    expect(cache(plane, far)).toHaveLength(4);
    expect(s.asks()).toBe(2);
    const r2 = s.reaches[1]!;
    expect(r2.minx).toBeLessThanOrEqual(r.minx);
    expect(r2.maxx).toBeGreaterThanOrEqual(far.maxx);
  });

  it("asks again when the model changes, serving the last answer meanwhile", async () => {
    // A rebuild must not flash every split profile whole while the answer for
    // the new model is on its way.
    const s = source({});
    const cache = profileCutCache(s.src);
    const plane = topPlane();
    cache(plane, need);
    await s.flush();
    s.retarget({});
    expect(cache(plane, need)).toHaveLength(4);
    expect(s.asks()).toBe(2);
  });

  it("drops an answer for a model that is no longer on screen", async () => {
    const s = source({});
    const cache = profileCutCache(s.src);
    const plane = topPlane();
    cache(plane, need);
    s.retarget({});
    await s.flush();
    expect(s.landed()).toBe(0);
    expect(cache(plane, null)).toEqual([]);
  });

  it("reads no answer as no footprint, and asks nothing for a sketch with no curves", async () => {
    const s = source({}, null);
    const cache = profileCutCache(s.src);
    const plane = topPlane();
    expect(cache(plane, null)).toEqual([]);
    expect(s.asks()).toBe(0);
    cache(plane, need);
    await s.flush();
    expect(cache(plane, need)).toEqual([]);
    expect(s.landed()).toBe(0);
    expect(s.asks()).toBe(1);
  });

  it("keeps the split it has while the engine holds no build, and asks again once one lands", async () => {
    const s = source({});
    const cache = profileCutCache(s.src);
    const plane = topPlane();
    cache(plane, need);
    await s.flush();
    s.retarget({});
    s.answer(null);
    cache(plane, need);
    await s.flush();
    expect(cache(plane, need)).toHaveLength(4);
    expect(s.asks()).toBe(2);
    expect(s.landed()).toBe(1);
    expect(cache.stale()).toBe(false);
    s.retarget({});
    expect(cache.stale()).toBe(true);
    s.answer(rim.slice(0, 2));
    cache(plane, need);
    await s.flush();
    expect(s.asks()).toBe(3);
    expect(cache(plane, need)).toHaveLength(2);
    expect(cache.stale()).toBe(false);
  });

  it("splits again at once when no answer comes back after the model already changed", async () => {
    const s = source({}, null);
    const cache = profileCutCache(s.src);
    cache(topPlane(), need);
    s.retarget({});
    await s.flush();
    expect(s.landed()).toBe(1);
  });

  it("never splits another document's areas along this one's lines on the same plane", async () => {
    const s = source({});
    const cache = profileCutCache(s.src);
    const plane = topPlane();
    cache(plane, need);
    await s.flush();
    expect(cache(plane, need)).toHaveLength(4);
    s.open();
    expect(cache(plane, need)).toEqual([]);
    expect(s.asks()).toBe(2);
    s.open();
    cache(plane, need);
    await s.flush();
    expect(s.landed()).toBe(2);
    expect(cache(plane, null)).toHaveLength(4);
  });
});

describe("faceFocus", () => {
  const sq = (cx: number, cy: number, h: number) => [
    new THREE.Vector2(cx - h, cy - h), new THREE.Vector2(cx + h, cy - h),
    new THREE.Vector2(cx + h, cy + h), new THREE.Vector2(cx - h, cy + h),
  ];
  it("centres on the smallest loop around the click, not the origin", () => {
    const c = faceFocus([sq(100, 40, 30), sq(100, 40, 10)], new THREE.Vector2(120, 40));
    expect(c?.x).toBeCloseTo(100);
    expect(c?.y).toBeCloseTo(40);
  });
  it("is null when no loop holds the click", () => {
    expect(faceFocus([sq(0, 0, 5)], new THREE.Vector2(50, 50))).toBeNull();
  });
});
