// A chain offset keeps a spline or B-spline edge: the copy is a closed profile, or the offset is refused out loud.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { solveKeepingAxes } from "../../src/sketch/sketchSolve";
import { bsplinePolyline } from "../../src/sketch/bspline";
import { offsetChain, type OffsetResult } from "../../src/sketch/modify";
import { distToSeg } from "../../src/sketch/geom2d";
import type { ResolvedEntity } from "../../src/sketch/snap";

type P = [number, number];
const a0 = 0.37,
  ox = 61.3,
  oy = -27.9;
const xf = ([x, y]: P): P => [ox + x * Math.cos(a0) - y * Math.sin(a0), oy + x * Math.sin(a0) + y * Math.cos(a0)];
const L = (id: string, p: P, q: P): ResolvedEntity => {
  const [x1, y1] = xf(p),
    [x2, y2] = xf(q);
  return { type: "line", id, x1, y1, x2, y2 };
};
const spline = (id: string, pts: P[]): ResolvedEntity => ({
  type: "spline",
  id,
  points: pts.map((p) => {
    const [x, y] = xf(p);
    return { x, y };
  }),
});

const A: P = [0, 0],
  B: P = [40, -6],
  C: P = [44, 30],
  D: P = [-4, 34],
  E: P = [-8, 14];
const bulge = (t: number): P => [B[0] + (C[0] - B[0]) * t + 8 * Math.sin(Math.PI * t), B[1] + (C[1] - B[1]) * t];
const bulgePts = Array.from({ length: 9 }, (_, k) => bulge(k / 8));
// a CCW loop of slanted lines with one spline bulging outward on its right
const loop = (): ResolvedEntity[] => [
  L("l1", A, B),
  spline("s", bulgePts),
  L("l2", C, D),
  L("l3", D, E),
  L("l4", E, A),
];

const ends = (e: ResolvedEntity): [P, P] => {
  if (e.type === "spline")
    return [
      [e.points[0]!.x, e.points[0]!.y],
      [e.points.at(-1)!.x, e.points.at(-1)!.y],
    ];
  if (e.type === "bspline")
    return [
      [e.poles[0]!.x, e.poles[0]!.y],
      [e.poles.at(-1)!.x, e.poles.at(-1)!.y],
    ];
  if (e.type === "line")
    return [
      [e.x1, e.y1],
      [e.x2, e.y2],
    ];
  throw new Error(e.type);
};
const polyOf = (e: ResolvedEntity) => (e.type === "spline" ? e.points : e.type === "bspline" ? bsplinePolyline(e) : []);
const copiesOf = (ents: ResolvedEntity[], r: OffsetResult) => r.entities.slice(ents.length);

/** how many OTHER copy endpoints sit exactly on each copy endpoint, in copy order */
function touching(copies: ResolvedEntity[]): number[] {
  return copies.flatMap((c, i) =>
    ends(c).map(
      (p) =>
        copies.flatMap((d, j) => (j === i ? [] : ends(d))).filter((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9)
          .length,
    ),
  );
}
const polygon = (ents: ResolvedEntity[]): P[] => {
  const [l1, s, l2, l3, l4] = ents;
  return [...ends(l1!), ...polyOf(s!).map((p): P => [p.x, p.y]), ...ends(l2!), ...ends(l3!), ...ends(l4!)];
};
const inside = (poly: P[], [x, y]: P) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!,
      [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const distToPoly = (pts: { x: number; y: number }[], q: { x: number; y: number }) =>
  Math.min(...pts.slice(1).map((p, k) => distToSeg(pts[k]! as never, p as never, q as never)));
const round = (n: number) => +n.toFixed(6);
const shape = (e: ResolvedEntity) => JSON.stringify([e.type, ...ends(e).flat().map(round)]);

describe("offsetChain keeps a spline edge in the chain", () => {
  for (const [dist, side] of [
    [3, "inward"],
    [-3, "outward"],
  ] as const) {
    for (const [pick, what] of [
      [0, "a line"],
      [1, "the spline"],
    ] as const) {
      it(`${side} by ${Math.abs(dist)}, picking ${what}, closes the profile and keeps the solver happy`, async () => {
        const ents = loop();
        const r = offsetChain(ents, pick, dist)!;
        expect(r.refused).toBeUndefined();
        const copies = copiesOf(ents, r);
        expect(copies.map((c) => c.type).sort()).toEqual(["line", "line", "line", "line", "spline"]);
        expect(touching(copies)).toEqual(copies.flatMap(() => [1, 1]));
        // the solver ties lines only, a spline has no offset pair
        expect(r.pairs.map((p) => p.src).sort()).toEqual(["l1", "l2", "l3", "l4"]);
        expect(r.linked).toBe(true);

        const src = (ents[1] as Extract<ResolvedEntity, { type: "spline" }>).points;
        const cpy = copies.find((c) => c.type === "spline") as Extract<ResolvedEntity, { type: "spline" }>;
        const interior = cpy.points.slice(2, -2);
        expect(interior.length).toBeGreaterThan(2);
        for (const p of interior) expect(Math.abs(distToPoly(src, p) - 3)).toBeLessThan(0.3);
        const mid = cpy.points[Math.floor(cpy.points.length / 2)]!;
        expect(inside(polygon(ents), [mid.x, mid.y])).toBe(dist > 0);

        const solved = await solveKeepingAxes([...ents, ...copies], [{ type: "offset", pairs: r.pairs, value: dist }]);
        expect(solved.conflicts).toEqual([]);
        expect(solved.entities.slice(ents.length).map(shape)).toEqual(copies.map(shape));
      });
    }
    it(`${side} by ${Math.abs(dist)}, both picks give the same copies`, () => {
      const ents = loop();
      const geo = (pick: number) =>
        copiesOf(ents, offsetChain(ents, pick, dist)!)
          .map(shape)
          .sort();
      expect(geo(1)).toEqual(geo(0));
    });
  }

  it("trims the spline when the offset eats into it and extends it when the offset moves away", () => {
    const ents = loop();
    const count = (d: number) =>
      (copiesOf(ents, offsetChain(ents, 0, d)!).find((c) => c.type === "spline") as any).points.length;
    // 9 source samples, an inward offset cuts the end segments short, an outward one adds the two join points
    expect(count(3)).toBe(9);
    expect(count(-3)).toBe(11);
  });

  it("leaves the free ends of an open chain alone and joins only the corners it has", () => {
    const ents = loop().slice(0, 3);
    const r = offsetChain(ents, 1, 3)!;
    const copies = copiesOf(ents, r);
    expect(copies.map((c) => c.type)).toEqual(["line", "spline", "line"]);
    expect(touching(copies)).toEqual([0, 1, 1, 1, 1, 0]);
    expect(r.pairs.map((p) => p.src).sort()).toEqual(["l1", "l2"]);
  });

  it("offsets a lone spline as before and a closed spline is not a chain link", () => {
    const ents = loop();
    expect(offsetChain([ents[1]!], 0, 3)).toBeNull();
    const ring: P[] = [
      [0, 0],
      [6, 1],
      [8, 6],
      [3, 9],
      [-2, 5],
      [0, 0],
    ];
    expect(offsetChain([spline("ring", ring), L("x", [0, 0], [5, -4])], 0, 1)).toBeNull();
  });

  it("gives up on a junction that touches a spline", () => {
    const ents = [...loop(), L("extra", B, [60, -20])];
    expect(offsetChain(ents, 1, 3)).toBeNull();
  });

  it("offsets a B-spline edge the same way, its fit ends meeting the neighbours", async () => {
    const poles = ([B, [46, -1], [48, 9], [38, 20], [47, 25], C] as P[]).map(xf);
    const ents: ResolvedEntity[] = [
      L("l1", A, B),
      { type: "bspline", id: "b", poles: poles.map(([x, y]) => ({ x, y })) },
      L("l2", C, D),
      L("l3", D, E),
      L("l4", E, A),
    ];
    for (const dist of [3, -3]) {
      const r = offsetChain(ents, 1, dist)!;
      const copies = copiesOf(ents, r);
      expect(copies.map((c) => c.type).sort()).toEqual(["bspline", "line", "line", "line", "line"]);
      expect(touching(copies)).toEqual(copies.flatMap(() => [1, 1]));
      const src = bsplinePolyline(ents[1] as never);
      const cpy = bsplinePolyline(copies.find((c) => c.type === "bspline") as never);
      for (const p of cpy.slice(8, -8)) expect(Math.abs(distToPoly(src, p) - 3)).toBeLessThan(0.5);
      const solved = await solveKeepingAxes([...ents, ...copies], [{ type: "offset", pairs: r.pairs, value: dist }]);
      expect(solved.conflicts).toEqual([]);
    }
  });
});

describe("offsetChain never hands back an open profile around a spline", () => {
  const bump = (): ResolvedEntity[] => {
    // a quarter-turn bump of radius 4 on the right of a slanted triangle-ish loop
    const pts: P[] = Array.from({ length: 9 }, (_, k) => {
      const t = -Math.PI / 2 + (k / 8) * Math.PI;
      return [30 + 4 * Math.cos(t), 4 + 4 * Math.sin(t)];
    });
    return [L("l1", [0, 0], [30, 0]), spline("s", pts), L("l2", [30, 8], [0, 60]), L("l3", [0, 60], [0, 0])];
  };
  const refusal = (ents: ResolvedEntity[]) => ({ entities: ents, pairs: [], linked: false, refused: true });

  it("refuses an inward offset past the radius of the bump, since no neighbour meets the offset spline", () => {
    for (const d of [5, 10]) {
      const ents = bump();
      expect(offsetChain(ents, 0, d)).toEqual(refusal(ents));
      expect(offsetChain(ents, 1, d)).toEqual(refusal(ents));
    }
  });

  it("joins just under the radius and on the outward side", () => {
    for (const d of [3.9, 6, -2, -6]) {
      const ents = bump();
      const r = offsetChain(ents, 0, d)!;
      expect(r.refused).toBeUndefined();
      expect(touching(copiesOf(ents, r))).toEqual(copiesOf(ents, r).flatMap(() => [1, 1]));
    }
  });

  const wavy = (pts: P[], c: P): ResolvedEntity[] => [
    L("l1", [0, 0], [30, 0]),
    spline("s", pts),
    L("l2", c, [0, 60]),
    L("l3", [0, 60], [0, 0]),
  ];
  const cases: [string, P[], P, number][] = [
    [
      "an offset spline that crosses itself",
      [
        [30, 0],
        [29.75, 1.19],
        [34.84, 4.71],
        [30.41, 8.93],
        [31.21, 11.86],
        [35.24, 11.75],
        [34.51, 15.84],
        [34.46, 17.33],
        [34.85, 20.72],
      ],
      [34.85, 20.72],
      6.483,
    ],
    [
      "neighbours that cut the offset spline past each other",
      [
        [30, 0],
        [29.67, 2.87],
        [31.44, 3.75],
        [30.08, 2.64],
      ],
      [30.08, 2.64],
      2.856,
    ],
  ];
  for (const [what, pts, c, d] of cases) {
    it(`refuses ${what}`, () => {
      const ents = wavy(pts, c);
      expect(offsetChain(ents, 0, d)).toEqual(refusal(ents));
    });
    it(`offsets the same spline once the distance is small, for ${what}`, () => {
      const ents = wavy(pts, c);
      const r = offsetChain(ents, 0, 0.2)!;
      expect(r.refused).toBeUndefined();
      // the far corner of this thin loop is butted by the miter limit, the spline's own joints are what matters
      expect(touching(copiesOf(ents, r)).slice(0, 5)).toEqual([1, 1, 1, 1, 1]);
    });
  }
});
