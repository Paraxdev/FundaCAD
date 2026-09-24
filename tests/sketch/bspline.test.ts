import { describe, it, expect } from "vitest";
import {
  bsplineDegree, bsplineFit, bsplineInsertKnot, bsplineKnots, bsplineMinPoles, bsplineNearestParam,
  bsplinePoint, bsplinePolyline, bsplineRange, bsplineRemovePole, poleOfRef, poleRef, type BsplineDef,
} from "../../src/sketch/bspline";

import VECTORS from "../vectors/bspline.json";

const wave: BsplineDef["poles"] = [
  { x: 0, y: 0 }, { x: 10, y: 25 }, { x: 30, y: -5 }, { x: 45, y: 30 }, { x: 60, y: 10 }, { x: 80, y: 40 }, { x: 95, y: 0 },
];
const ring: BsplineDef["poles"] = [
  { x: 0, y: -20 }, { x: 25, y: -18 }, { x: 30, y: 5 }, { x: 12, y: 28 }, { x: -15, y: 22 }, { x: -28, y: 0 },
];

function samplesOf(def: BsplineDef, n = 41): number[] {
  const [a, b] = bsplineRange(def);
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

function expectSameCurve(a: BsplineDef, b: BsplineDef, tol = 1e-9) {
  expect(bsplineRange(b)).toEqual(bsplineRange(a));
  for (const t of samplesOf(a, 397)) {
    const p = bsplinePoint(a, t), q = bsplinePoint(b, t);
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(tol);
  }
}

describe("bspline evaluation", () => {
  it("clamps the degree to the pole count", () => {
    expect(bsplineDegree({ poles: wave })).toBe(3);
    expect(bsplineDegree({ poles: wave.slice(0, 3), degree: 5 })).toBe(2);
    expect(bsplineDegree({ poles: wave.slice(0, 2) })).toBe(1);
  });

  it("uses uniform knots unless valid ones are stored", () => {
    expect(bsplineKnots({ poles: wave })).toEqual([0, 1, 2, 3, 4]);
    expect(bsplineKnots({ poles: ring, closed: true })).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(bsplineKnots({ poles: wave, knots: [0, 1, 1, 3, 4] })).toEqual([0, 1, 2, 3, 4]);
    expect(bsplineKnots({ poles: wave, knots: [0, 0.5, 2, 3, 4] })).toEqual([0, 0.5, 2, 3, 4]);
  });

  it("an open curve starts and ends on its end poles", () => {
    for (const degree of [2, 3, 5]) {
      const def = { poles: wave, degree };
      const [a, b] = bsplineRange(def);
      expect(bsplinePoint(def, a)).toEqual(wave[0]);
      const end = bsplinePoint(def, b);
      expect(end.x).toBeCloseTo(95, 12);
      expect(end.y).toBeCloseTo(0, 12);
    }
  });

  it("four poles of degree 3 are a Bezier curve", () => {
    const P = wave.slice(0, 4);
    for (const s of [0.1, 0.37, 0.5, 0.9]) {
      const c = bsplinePoint({ poles: P }, s);
      const w = [(1 - s) ** 3, 3 * s * (1 - s) ** 2, 3 * s * s * (1 - s), s ** 3];
      const x = w.reduce((acc, wi, i) => acc + wi * P[i]!.x, 0);
      const y = w.reduce((acc, wi, i) => acc + wi * P[i]!.y, 0);
      expect(c.x).toBeCloseTo(x, 12);
      expect(c.y).toBeCloseTo(y, 12);
    }
  });

  it("a closed uniform cubic passes (P0 + 4 P1 + P2) / 6 at its first knot and closes", () => {
    const def = { poles: ring, closed: true };
    const c = bsplinePoint(def, 0);
    expect(c.x).toBeCloseTo((ring[0]!.x + 4 * ring[1]!.x + ring[2]!.x) / 6, 12);
    expect(c.y).toBeCloseTo((ring[0]!.y + 4 * ring[1]!.y + ring[2]!.y) / 6, 12);
    const e = bsplinePoint(def, 6);
    expect(Math.hypot(e.x - c.x, e.y - c.y)).toBeLessThan(1e-12);
    const line = bsplinePolyline(def, 8);
    expect(line).toHaveLength(6 * 8 + 1);
    expect(line.at(-1)).toEqual(line[0]);
  });

  it("draws a curve with few knot spans as finely as one with many", () => {
    // A degree 5 curve on six poles is a single span; sampled per span it was
    // sixteen visible facets.
    const def: BsplineDef = { poles: wave.slice(0, 6), degree: 5 };
    const line = bsplinePolyline(def, 16);
    let worst = 0;
    for (const t of samplesOf(def, 2001)) {
      const c = bsplinePoint(def, t);
      let best = Infinity;
      for (let i = 0; i + 1 < line.length; i++) {
        const A = line[i]!, B = line[i + 1]!;
        const dx = B.x - A.x, dy = B.y - A.y;
        const u = Math.max(0, Math.min(1, ((c.x - A.x) * dx + (c.y - A.y) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(A.x + u * dx - c.x, A.y + u * dy - c.y));
      }
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThan(0.02);
  });

  it("finds the parameter nearest a point", () => {
    const def = { poles: wave };
    const t = 2.3;
    const on = bsplinePoint(def, t);
    expect(bsplineNearestParam(def, on)).toBeCloseTo(t, 6);
  });
});

describe("bspline pole insertion (Boehm)", () => {
  for (const closed of [false, true]) {
    for (const degree of [2, 3, 5]) {
      it(`adds a pole without moving the ${closed ? "closed" : "open"} degree ${degree} curve`, () => {
        let def: BsplineDef = { poles: closed ? ring : wave, degree, closed };
        const original = def;
        const [a, b] = bsplineRange(def);
        for (const f of [0.1, 0.677, 0.875, 0.2625, 0.9975, 0.005]) {
          const next = bsplineInsertKnot(def, a + (b - a) * f);
          expect(next).not.toBeNull();
          expect(next!.poles).toHaveLength(def.poles.length + 1);
          expectSameCurve(original, next!);
          def = next!;
        }
      });
    }
  }

  it("refuses a parameter on an existing knot or outside the range", () => {
    const def = { poles: wave };
    expect(bsplineInsertKnot(def, 2)).toBeNull();
    expect(bsplineInsertKnot(def, 0)).toBeNull();
    expect(bsplineInsertKnot(def, 4.5)).toBeNull();
  });
});

describe("bspline pole removal", () => {
  it("stops at degree + 1 poles", () => {
    const def = { poles: wave.slice(0, 5) };
    expect(bsplineMinPoles(def)).toBe(4);
    const four = bsplineRemovePole(def, 2)!;
    expect(four.poles).toHaveLength(4);
    expect(bsplineRemovePole(four, 1)).toBeNull();
  });

  it("drops one stored knot with the pole", () => {
    const def = bsplineInsertKnot({ poles: wave }, 1.5)!;
    const out = bsplineRemovePole(def, 3)!;
    expect(out.poles).toHaveLength(wave.length);
    expect(bsplineKnots(out)).toEqual(out.knots);
  });
});

describe("pole references", () => {
  it("round-trip, with the ends at 0 and 1", () => {
    const n = 7;
    expect(poleRef(0, n)).toBe(0);
    expect(poleRef(n - 1, n)).toBe(1);
    for (let k = 0; k < n; k++) expect(poleOfRef(poleRef(k, n), n)).toBe(k);
    expect(poleOfRef(n, n)).toBe(-1);
  });
});

describe("bspline fit", () => {
  it("keeps the ends and stays close to an open sampled curve", () => {
    const target = { poles: wave };
    const samples = bsplinePolyline(target, 20);
    const fit = bsplineFit(samples, 20, false)!;
    expect(fit.poles[0]).toEqual(samples[0]);
    expect(fit.poles.at(-1)).toEqual(samples.at(-1));
    for (const s of samples) {
      const t = bsplineNearestParam(fit, s);
      const c = bsplinePoint(fit, t);
      expect(Math.hypot(c.x - s.x, c.y - s.y)).toBeLessThan(0.1);
    }
  });

  it("fits a closed loop with a periodic curve", () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({ x: 20 * Math.cos((i / 60) * 2 * Math.PI), y: 12 * Math.sin((i / 60) * 2 * Math.PI) }));
    const fit = bsplineFit(samples, 10, true)!;
    expect(fit.closed).toBe(true);
    for (const s of samples) {
      const c = bsplinePoint(fit, bsplineNearestParam(fit, s));
      expect(Math.hypot(c.x - s.x, c.y - s.y)).toBeLessThan(0.1);
    }
  });
});

// The engine samples OCCT's curve for the same cases in
// crates/fundacad-geom/tests/bspline_sketch.rs.
describe("shared vectors", () => {
  const cases: { name: string; def: BsplineDef }[] = [
    { name: "open cubic", def: { poles: wave } },
    { name: "open quadratic", def: { poles: wave, degree: 2 } },
    { name: "open quintic", def: { poles: wave, degree: 5 } },
    { name: "open clamped to degree 2", def: { poles: wave.slice(0, 3), degree: 5 } },
    { name: "open line", def: { poles: wave.slice(0, 2) } },
    { name: "open with inserted knots", def: bsplineInsertKnot(bsplineInsertKnot({ poles: wave }, 1.3)!, 3.7)! },
    { name: "closed cubic", def: { poles: ring, closed: true } },
    { name: "closed quadratic", def: { poles: ring, degree: 2, closed: true } },
    { name: "closed quintic", def: { poles: ring, degree: 5, closed: true } },
    { name: "closed triangle", def: { poles: ring.slice(0, 3), closed: true } },
    { name: "closed with inserted knots", def: bsplineInsertKnot(bsplineInsertKnot({ poles: ring, closed: true }, 5.5)!, 0.25)! },
  ];
  const record = () => cases.map(({ name, def }) => ({
    name,
    poles: def.poles.map((q) => [q.x, q.y]),
    degree: bsplineDegree(def),
    closed: !!def.closed,
    knots: bsplineKnots(def),
    samples: samplesOf(def, 23).map((t) => { const c = bsplinePoint(def, t); return [t, c.x, c.y]; }),
  }));

  it("match the recorded file", () => {
    const fresh = record();
    const saved = VECTORS as unknown as { cases: ReturnType<typeof record> };
    expect(saved.cases.map((c) => c.name)).toEqual(fresh.map((c) => c.name));
    saved.cases.forEach((c, i) => {
      const def: BsplineDef = { poles: c.poles.map(([x, y]) => ({ x: x!, y: y! })), degree: c.degree, closed: c.closed, knots: c.knots };
      expect(bsplineKnots(def)).toEqual(c.knots);
      for (const [t, x, y] of c.samples) {
        const q = bsplinePoint(def, t!);
        expect(Math.hypot(q.x - x!, q.y - y!)).toBeLessThan(1e-9);
      }
      expect(fresh[i]!.samples.length).toBe(c.samples.length);
    });
  });
});
