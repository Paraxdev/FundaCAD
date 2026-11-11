import { describe, expect, it } from "vitest";
import {
  chainLoops,
  cornerFlags,
  insetRing,
  sweepPolylines,
  type Polyline,
  type SweepSpec,
  type V3,
} from "../../src/features/sweepOutline";

// A slanted plane off the origin: u, v in the plane, n = u x v, all unit.
const U: V3 = [2 / 3, 1 / 3, -2 / 3];
const V: V3 = [-2 / 3, 2 / 3, -1 / 3];
const N: V3 = [1 / 3, 2 / 3, 2 / 3];
const O: V3 = [3, -2, 5];

type AB = [number, number];

const P = (a: number, b: number, h = 0): V3 => [
  O[0] + a * U[0] + b * V[0] + h * N[0],
  O[1] + a * U[1] + b * V[1] + h * N[1],
  O[2] + a * U[2] + b * V[2] + h * N[2],
];

const clean = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
const R = (lines: Polyline[]) => lines.map((l) => l.map((p) => p.map(clean)));
const W = (pts: AB[]) => pts.map(([a, b]) => P(a, b));
const loop = (pts: AB[], h: number): Polyline => [...pts, pts[0]!].map(([a, b]) => P(a, b, h));
const rise = (pts: AB[], top: number): Polyline[] => pts.map(([a, b]) => [P(a, b, 0), P(a, b, top)]);

const spec = (over: Partial<SweepSpec> & Pick<SweepSpec, "rings">): SweepSpec => ({
  normal: N,
  axis: N,
  stations: [
    { along: 0, inset: 0 },
    { along: 4, inset: 0 },
  ],
  ...over,
});

const rect = (a0: number, b0: number, a1: number, b1: number): AB[] => [
  [a0, b0],
  [a1, b0],
  [a1, b1],
  [a0, b1],
];

const arc = (cx: number, cy: number, r: number, from: number, to: number, steps: number): AB[] =>
  Array.from({ length: steps + 1 }, (_, i): AB => {
    const t = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
  });

describe("sweepPolylines", () => {
  it("a rectangle gives two rings and a side at each of its four corners", () => {
    const pts = rect(1, 2, 7, 5);
    const out = sweepPolylines(spec({ rings: [{ points: W(pts) }] }));
    expect(R(out)).toEqual(R([loop(pts, 0), loop(pts, 4), ...rise(pts, 4)]));
  });

  it("a rectangle wound the other way draws the same rings and sides", () => {
    const flipped = rect(1, 2, 7, 5).reverse();
    const out = sweepPolylines(spec({ rings: [{ points: W(flipped) }] }));
    expect(R(out)).toEqual(R([loop(flipped, 0), loop(flipped, 4), ...rise(flipped, 4)]));
  });

  it("a 64 segment circle gives two rings and no side line", () => {
    const pts = arc(2, 1, 3, 0, 360, 64).slice(0, 64);
    const out = sweepPolylines(spec({ rings: [{ points: W(pts) }] }));
    expect(R(out)).toEqual(R([loop(pts, 0), loop(pts, 4)]));
    expect(out[0]).toHaveLength(65);
  });

  it("a slot gets sides at its four tangent ends only", () => {
    const pts = [...arc(10, 0, 2, -90, 90, 24), ...arc(0, 0, 2, 90, 270, 24)];
    const ends = [0, 24, 25, 49];
    const plain = sweepPolylines(spec({ rings: [{ points: W(pts) }] }));
    expect(R(plain)).toEqual(R([loop(pts, 0), loop(pts, 4)]));
    const joints = pts.map((_, i) => ends.includes(i));
    const marked = sweepPolylines(spec({ rings: [{ points: W(pts), joints }] }));
    expect(R(marked)).toEqual(
      R([
        loop(pts, 0),
        loop(pts, 4),
        ...rise(
          ends.map((i) => pts[i]!),
          4,
        ),
      ]),
    );
  });

  it("a washer keeps its hole as its own rings and sides", () => {
    const outer = rect(0, 0, 10, 10);
    const hole = rect(3, 3, 7, 7).reverse();
    const out = sweepPolylines(spec({ rings: [{ points: W(outer) }, { points: W(hole) }] }));
    expect(R(out)).toEqual(
      R([loop(outer, 0), loop(outer, 4), ...rise(outer, 4), loop(hole, 0), loop(hole, 4), ...rise(hole, 4)]),
    );
  });

  it("a positive taper shrinks the outer ring and grows the hole by depth times tan", () => {
    const i = 4 * Math.tan((10 * Math.PI) / 180);
    const outer = rect(0, 0, 10, 10);
    const hole = rect(3, 3, 7, 7).reverse();
    const stations = [
      { along: 0, inset: 0 },
      { along: 4, inset: i },
    ];
    const out = sweepPolylines(spec({ rings: [{ points: W(outer) }, { points: W(hole) }], stations }));
    const smaller = rect(i, i, 10 - i, 10 - i);
    const bigger = rect(3 - i, 3 - i, 7 + i, 7 + i).reverse();
    expect(R(out)).toEqual(
      R([
        loop(outer, 0),
        loop(smaller, 4),
        ...outer.map(([a, b], k): Polyline => [P(a, b, 0), P(...smaller[k]!, 4)]),
        loop(hole, 0),
        loop(bigger, 4),
        ...hole.map(([a, b], k): Polyline => [P(a, b, 0), P(...bigger[k]!, 4)]),
      ]),
    );
  });

  it("a negative inset leans the profile out", () => {
    const stations = [
      { along: 0, inset: 0 },
      { along: 2, inset: -0.5 },
    ];
    const out = sweepPolylines(spec({ rings: [{ points: W(rect(1, 2, 7, 5)) }], stations }));
    expect(R([out[1]!])).toEqual(R([loop(rect(0.5, 1.5, 7.5, 5.5), 2)]));
  });

  it("an inset past the inradius keeps the base ring at that station and the sides stay straight", () => {
    const pts = rect(1, 2, 7, 5);
    const run = (inset: number) =>
      sweepPolylines(
        spec({
          rings: [{ points: W(pts) }],
          stations: [
            { along: 0, inset: 0 },
            { along: 4, inset },
          ],
        }),
      );
    expect(R([run(1.4)[1]!])).toEqual(R([loop(rect(2.4, 3.4, 5.6, 3.6), 4)]));
    expect(R([run(1.5)[1]!])).toEqual(R([loop(pts, 4)]));
    expect(R([run(9)[1]!])).toEqual(R([loop(pts, 4)]));
    expect(R(run(9).slice(2))).toEqual(R(rise(pts, 4)));
  });

  it("only the station that fails falls back, the sides kink through the ones that fit", () => {
    const pts = rect(1, 2, 7, 5);
    const stations = [
      { along: 0, inset: 0 },
      { along: 1, inset: 0.5 },
      { along: 2, inset: 2 },
    ];
    const out = sweepPolylines(spec({ rings: [{ points: W(pts) }], stations }));
    expect(R([out[0]!, out[1]!, out[2]!])).toEqual(
      R([loop(pts, 0), loop(pts, 2), [P(1, 2, 0), P(1.5, 2.5, 1), P(1, 2, 2)]]),
    );
  });

  it("a symmetric extrude has rings at both ends and sides kinking at the plane", () => {
    const i = 3 * Math.tan((5 * Math.PI) / 180);
    const stations = [
      { along: -3, inset: i },
      { along: 0, inset: 0 },
      { along: 3, inset: i },
    ];
    const pts = rect(1, 2, 7, 5);
    const out = sweepPolylines(spec({ rings: [{ points: W(pts) }], stations }));
    const inner = rect(1 + i, 2 + i, 7 - i, 5 - i);
    expect(R(out)).toEqual(
      R([
        loop(inner, -3),
        loop(inner, 3),
        ...pts.map(([a, b], k): Polyline => [P(...inner[k]!, -3), P(a, b, 0), P(...inner[k]!, 3)]),
      ]),
    );
  });

  it("a cut axis points the other way and the inset still goes toward the material", () => {
    const stations = [
      { along: 0, inset: 0 },
      { along: 2, inset: 0.25 },
    ];
    const pts = rect(1, 2, 7, 5);
    const out = sweepPolylines(spec({ rings: [{ points: W(pts) }], axis: [-N[0], -N[1], -N[2]], stations }));
    const inner = rect(1.25, 2.25, 6.75, 4.75);
    expect(R(out)).toEqual(
      R([loop(pts, 0), loop(inner, -2), ...pts.map(([a, b], k): Polyline => [P(a, b, 0), P(...inner[k]!, -2)])]),
    );
  });

  it("nothing in gives nothing out, one station gives one ring, a ring under three points is skipped", () => {
    const pts = W(rect(1, 2, 7, 5));
    expect(sweepPolylines(spec({ rings: [] }))).toEqual([]);
    expect(sweepPolylines(spec({ rings: [{ points: pts }], stations: [] }))).toEqual([]);
    const one = sweepPolylines(spec({ rings: [{ points: pts }], stations: [{ along: 3, inset: 0 }] }));
    expect(R(one)).toEqual(R([loop(rect(1, 2, 7, 5), 3)]));
    expect(sweepPolylines(spec({ rings: [{ points: pts.slice(0, 2) }, { points: pts }] }))).toHaveLength(6);
  });
});

describe("cornerFlags", () => {
  const flat = (a: number, b: number): V3 => [a + 10, b - 7, 3];

  it("flags a turn above the threshold and not the exact threshold", () => {
    const ring = { points: [flat(0, 0), flat(10, 0), flat(10, 10), flat(0, 10)] };
    expect(cornerFlags(ring, 90)).toEqual([false, false, false, false]);
    expect(cornerFlags(ring, 89.99)).toEqual([true, true, true, true]);
  });

  it("the default threshold sits between a 19 and a 21 degree turn", () => {
    const turn = (deg: number): V3[] => {
      const t = (deg * Math.PI) / 180;
      return [flat(0, 0), flat(10, 0), flat(10 + 10 * Math.cos(t), 10 * Math.sin(t)), flat(5, -9)];
    };
    expect(cornerFlags({ points: turn(19) })[1]).toBe(false);
    expect(cornerFlags({ points: turn(21) })[1]).toBe(true);
  });

  it("a joint is a corner however gentle the turn", () => {
    const pts = [flat(0, 0), flat(10, 0), flat(20, 1), flat(10, 8)];
    expect(cornerFlags({ points: pts })[1]).toBe(false);
    expect(cornerFlags({ points: pts, joints: [false, true, false, false] })[1]).toBe(true);
  });

  it("a repeated point is not a corner", () => {
    const pts = [flat(0, 0), flat(5, 0), flat(5, 0), flat(10, 0.5), flat(4, 9)];
    expect(cornerFlags({ points: pts }).slice(1, 3)).toEqual([false, false]);
  });
});

describe("insetRing", () => {
  const Z: V3 = [0, 0, 1];
  const at = (a: number, b: number): V3 => [a + 10, b - 7, 3];
  const L = [at(0, 0), at(4, 0), at(4, 2), at(2, 2), at(2, 4), at(0, 4)];

  it("moves an L shaped loop in along the miters, the reflex corner too", () => {
    expect(insetRing(L, Z, 0.5, false)).toEqual([
      at(0.5, 0.5),
      at(3.5, 0.5),
      at(3.5, 1.5),
      at(1.5, 1.5),
      at(1.5, 3.5),
      at(0.5, 3.5),
    ]);
  });

  it("a hole grows with the flag set, and the flag flips the side of a loop", () => {
    const hole = [...L].reverse();
    const grown = [at(-0.5, -0.5), at(4.5, -0.5), at(4.5, 2.5), at(2.5, 2.5), at(2.5, 4.5), at(-0.5, 4.5)];
    const shrunk = [at(0.5, 0.5), at(3.5, 0.5), at(3.5, 1.5), at(1.5, 1.5), at(1.5, 3.5), at(0.5, 3.5)];
    expect(insetRing(hole, Z, 0.5, true)).toEqual([...grown].reverse());
    expect(insetRing(hole, Z, 0.5, false)).toEqual([...shrunk].reverse());
    expect(insetRing(L, Z, 0.5, true)).toEqual(grown);
  });

  it("returns null at the first inset that flips an edge and not just below it", () => {
    const rc = [at(0, 0), at(20, 0), at(20, 10), at(0, 10)];
    expect(insetRing(rc, Z, 4.999, false)?.map((p) => p.map(clean))).toEqual(
      [at(4.999, 4.999), at(15.001, 4.999), at(15.001, 5.001), at(4.999, 5.001)].map((p) => p.map(clean)),
    );
    expect(insetRing(rc, Z, 5, false)).toBeNull();
    expect(insetRing(rc, Z, 5.001, false)).toBeNull();
  });

  it("returns null for a reversal spike, a doubled point and a ring under three points", () => {
    expect(insetRing([at(0, 0), at(4, 0), at(0, 0), at(0, 3)], Z, 0.1, false)).toBeNull();
    expect(insetRing([at(0, 0), at(4, 0), at(4, 0), at(4, 3), at(0, 3)], Z, 0.1, false)).toBeNull();
    expect(insetRing([at(0, 0), at(4, 0)], Z, 0.1, false)).toBeNull();
  });
});

describe("chainLoops", () => {
  const pt = (a: number, b: number): V3 => [a + 10, b - 7, 3];
  const e = (a: number, b: number, c: number, d: number): V3[] => [pt(a, b), pt(c, d)];

  it("closes four edges given in any order and direction, starting from the first edge", () => {
    const edges = [e(6, 0, 6, 3), e(0, 0, 6, 0), e(0, 3, 0, 0), e(6, 3, 0, 3)];
    expect(chainLoops(edges, 1e-6)).toEqual([
      { points: [pt(6, 0), pt(6, 3), pt(0, 3), pt(0, 0)], joints: [true, true, true, true] },
    ]);
  });

  it("the same rectangle given from another edge starts and runs elsewhere", () => {
    const edges = [e(0, 0, 6, 0), e(6, 3, 6, 0), e(6, 3, 0, 3), e(0, 0, 0, 3)];
    expect(chainLoops(edges, 1e-6)[0]?.points).toEqual([pt(0, 0), pt(6, 0), pt(6, 3), pt(0, 3)]);
  });

  it("keeps the inner vertices of a polyline edge and marks only the edge ends as joints", () => {
    const bulge = [pt(6, 0), pt(7, 1.5), pt(6, 3)];
    const rings = chainLoops([bulge, e(0, 3, 6, 3), e(0, 0, 0, 3), e(0, 0, 6, 0)], 1e-6);
    expect(rings).toEqual([
      {
        points: [pt(6, 0), pt(7, 1.5), pt(6, 3), pt(0, 3), pt(0, 0)],
        joints: [true, false, true, true, true],
      },
    ]);
  });

  it("two separate loops come out as two rings in the order of their first edges", () => {
    const edges = [e(20, 0, 24, 0), e(0, 0, 4, 1), e(4, 1, 2, 5), e(24, 0, 22, 3), e(2, 5, 0, 0), e(22, 3, 20, 0)];
    expect(chainLoops(edges, 1e-6).map((r) => r.points)).toEqual([
      [pt(20, 0), pt(24, 0), pt(22, 3)],
      [pt(0, 0), pt(4, 1), pt(2, 5)],
    ]);
  });

  it("leaves an open chain out and does not let it take edges from a closed loop", () => {
    const open = [e(0, 0, 6, 0), e(6, 0, 6, 3), e(6, 3, 0, 3)];
    expect(chainLoops(open, 1e-6)).toEqual([]);
    const mixed = [...open, e(30, 0, 33, 0), e(33, 0, 31, 2), e(31, 2, 30, 0)];
    expect(chainLoops(mixed, 1e-6).map((r) => r.points)).toEqual([[pt(30, 0), pt(33, 0), pt(31, 2)]]);
  });

  it("a gap equal to the tolerance joins and a gap above it does not", () => {
    const edges = [e(0, 0, 4, 0), e(4, 0.25, 4, 3), e(4, 3, 0, 3), e(0, 3, 0, 0)];
    expect(chainLoops(edges, 0.25)).toHaveLength(1);
    expect(chainLoops(edges, 0.2)).toEqual([]);
  });

  it("a single closed edge is a ring with no joint, no edges is no ring, one point is skipped", () => {
    const square = [pt(3, 0), pt(0, 3), pt(-3, 0), pt(0, -3), pt(3, 0)];
    expect(chainLoops([square], 1e-6)).toEqual([{ points: square.slice(0, 4), joints: [false, false, false, false] }]);
    const [ring] = chainLoops([W(arc(4, -2, 3, 30, 390, 48))], 1e-6);
    expect(ring?.points).toHaveLength(48);
    expect(cornerFlags(ring!)).toEqual(Array(48).fill(false));
    expect(chainLoops([], 1e-6)).toEqual([]);
    expect(chainLoops([[pt(1, 1)]], 1e-6)).toEqual([]);
  });

  it("feeds sweepPolylines with sides at the joints only", () => {
    const right = W(arc(10, 0, 2, -90, 90, 24));
    const left = W(arc(0, 0, 2, 90, 270, 24));
    const rings = chainLoops([right, [right[24]!, left[0]!], left, [left[24]!, right[0]!]], 1e-6);
    expect(rings).toHaveLength(1);
    expect(rings[0]?.points).toHaveLength(50);
    const out = sweepPolylines(spec({ rings }));
    const ends = [right[0]!, right[24]!, left[0]!, left[24]!];
    expect(R(out.slice(2))).toEqual(R(ends.map((p) => [p, [p[0] + 4 * N[0], p[1] + 4 * N[1], p[2] + 4 * N[2]] as V3])));
    expect(out).toHaveLength(6);
  });
});
