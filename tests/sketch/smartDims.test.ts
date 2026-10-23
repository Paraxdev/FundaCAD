// Smart dimensions: the cursor picks aligned, horizontal or vertical for a distance and
// the wedge of an angle; radius and arc diameter labels go where they are dragged.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { resolveDim, pickDimTarget, isDimError, type DimPlan, type DimTarget } from "../../src/sketch/dimensionTool";
import { compileAndSolve } from "../../src/sketch/sketchSolve";
import { constraintDims } from "../../src/sketch/entityDims";
import { applyDrivingDimsDirect, waitsForSolver } from "../../src/sketch/directDims";
import { measuredAngleDeg } from "../../src/sketch/angleWedge";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { PlaceOffset, SketchConstraint } from "../../src/types";

type Line = Extract<ResolvedEntity, { type: "line" }>;
const v = (x: number, y: number) => new THREE.Vector2(x, y);
const line = (id: string, x1: number, y1: number, x2: number, y2: number): Line => ({
  type: "line",
  id,
  x1,
  y1,
  x2,
  y2,
});
const pick = (ents: ResolvedEntity[], x: number, y: number): DimTarget => pickDimTarget(ents, v(x, y), 0.5)!;
const planOf = (r: ReturnType<typeof resolveDim>): DimPlan => {
  if (isDimError(r)) throw new Error(r.message);
  return r;
};
/** the cursor at (x, y), as the offset from the plan's label anchor */
const at = (p: DimPlan, x: number, y: number): PlaceOffset => {
  const a = p.labelAnchor()!;
  return { ox: x - a.x, oy: y - a.y };
};
const lineOf = (ents: ResolvedEntity[], id: string) => ents.find((e) => e.id === id) as Line;

describe("point to point distance picks its mode by the cursor", () => {
  const ents = [line("a", 0, 0, 30, 40)];
  const p = planOf(resolveDim([pick(ents, 0, 0), pick(ents, 30, 40)]));

  it("beside the pair is vertical, above it horizontal, near it aligned", () => {
    expect(p.measure(at(p, 60, 20))).toBeCloseTo(40);
    expect(p.measure(at(p, 15, 80))).toBeCloseTo(30);
    expect(p.measure(at(p, 16, 21))).toBeCloseTo(50);
    expect(p.measure(at(p, 60, 80))).toBeCloseTo(50);
    expect(p.measure()).toBeCloseTo(50);
  });

  it("makes vDistance, hDistance, or the old p2pDistance byte for byte", () => {
    const right = at(p, 60, 20),
      above = at(p, 15, 80),
      near = at(p, 16, 21);
    expect(p.make(40, right)).toEqual({ type: "vDistance", e1: "a", p1: 0, e2: "a", p2: 1, value: 40, place: right });
    expect(p.make(30, above)).toEqual({ type: "hDistance", e1: "a", p1: 0, e2: "a", p2: 1, value: 30, place: above });
    expect(p.make(50, near)).toEqual({ type: "p2pDistance", e1: "a", p1: 0, e2: "a", p2: 1, value: 50, place: near });
    expect(p.make(50)).toEqual({ type: "p2pDistance", e1: "a", p1: 0, e2: "a", p2: 1, value: 50 });
  });

  it("the hover cursor picks the mode when no label was placed", () => {
    expect(p.make(30, undefined, at(p, 15, 80))).toEqual({
      type: "hDistance",
      e1: "a",
      p1: 0,
      e2: "a",
      p2: 1,
      value: 30,
    });
  });

  it("orders the operands so the stored value is positive", () => {
    const q = planOf(resolveDim([pick(ents, 30, 40), pick(ents, 0, 0)]));
    expect(q.make(30, at(q, 15, 80))).toMatchObject({ type: "hDistance", e1: "a", p1: 0, e2: "a", p2: 1 });
  });

  it("an axis aligned pair never becomes a 0 mm or duplicate axis dim", () => {
    const up = [line("b", 0, 0, 0, 40)];
    const q = planOf(resolveDim([pick(up, 0, 0), pick(up, 0, 40)]));
    expect(q.make(40, at(q, 0, 80)).type).toBe("p2pDistance");
    expect(q.make(40, at(q, 20, 20)).type).toBe("p2pDistance");
  });
});

describe("a single line pick has the same three modes", () => {
  const ents = [line("a", 0, 0, 30, 40)];
  const p = planOf(resolveDim([pick(ents, 15, 20)]));

  it("aligned stays a plain length with no place, the others carry it", () => {
    expect(p.labelAnchor()).not.toBeNull();
    expect(p.make(50, at(p, 16, 21))).toEqual({ type: "distance", line: "a", value: 50 });
    expect(p.make(40, at(p, 60, 20))).toEqual({
      type: "vDistance",
      e1: "a",
      p1: 0,
      e2: "a",
      p2: 1,
      value: 40,
      place: at(p, 60, 20),
    });
    expect(p.measure(at(p, 15, 80))).toBeCloseTo(30);
  });
});

describe("horizontal and vertical distances solve", () => {
  it("drive the free end along x, then y", async () => {
    const ents = [line("a", 0, 0, 30, 40)];
    const r1 = await compileAndSolve(ents, [
      { type: "fix", e: "a", p: 0 },
      { type: "hDistance", e1: "a", p1: 0, e2: "a", p2: 1, value: 20 },
    ]);
    expect(r1.ok).toBe(true);
    expect(lineOf(r1.entities, "a").x2).toBeCloseTo(20, 6);
    const r2 = await compileAndSolve(ents, [
      { type: "fix", e: "a", p: 0 },
      { type: "hDistance", e1: "a", p1: 0, e2: "a", p2: 1, value: 20 },
      { type: "vDistance", e1: "a", p1: 0, e2: "a", p2: 1, value: 45 },
    ]);
    const l = lineOf(r2.entities, "a");
    expect(l.x2).toBeCloseTo(20, 6);
    expect(l.y2).toBeCloseTo(45, 6);
    expect(r2.conflicts).toEqual([]);
  });

  it("between two entities, with the right point staying right", async () => {
    const ents = [line("a", 0, 0, 0, 10), line("b", 30, 5, 30, 25)];
    const r = await compileAndSolve(ents, [
      { type: "fix", e: "a", p: 0 },
      { type: "fix", e: "a", p: 1 },
      { type: "vertical", line: "b" },
      { type: "hDistance", e1: "a", p1: 0, e2: "b", p2: 0, value: 12 },
    ]);
    expect(lineOf(r.entities, "b").x1).toBeCloseTo(12, 6);
    expect(lineOf(r.entities, "b").x2).toBeCloseTo(12, 6);
  });

  it("a pinned pair reports a wrong value as a conflict and a right one as redundant", async () => {
    const ents = [line("a", 0, 0, 30, 40)];
    const pins: SketchConstraint[] = [
      { type: "fix", e: "a", p: 0 },
      { type: "fix", e: "a", p: 1 },
    ];
    const bad = await compileAndSolve(ents, [
      ...pins,
      { type: "hDistance", e1: "a", p1: 0, e2: "a", p2: 1, value: 20 },
    ]);
    expect(bad.conflicts.length).toBeGreaterThan(0);
    const good = await compileAndSolve(ents, [
      ...pins,
      { type: "hDistance", e1: "a", p1: 0, e2: "a", p2: 1, value: 30 },
    ]);
    expect(good.conflicts).toEqual([]);
  });
});

describe("the angle takes the wedge the cursor is in", () => {
  const polar = (r: number, deg: number) =>
    [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)] as const;
  // l2 runs inward to the crossing at 60 degrees, so its stored direction points at 240
  const drawn = [line("l1", 0, 0, 10, 0), line("l2", 5, 5 * Math.sqrt(3) * 1, 0, 0)];
  const outward = [line("l1", 0, 0, 10, 0), line("l2", 0, 0, 5, 5 * Math.sqrt(3))];

  for (const [name, ents] of [
    ["inward", drawn],
    ["outward", outward],
  ] as const) {
    it(`reads 60, 120, 60, 120 round the crossing and 300 reflex (${name})`, () => {
      const p = planOf(resolveDim([pick(ents, 7, 0), pick(ents, 2.5, 2.5 * Math.sqrt(3))]));
      const read = (deg: number) => p.measure(at(p, ...polar(5, deg)));
      expect(read(30)).toBeCloseTo(60);
      expect(read(120)).toBeCloseTo(120);
      expect(read(210)).toBeCloseTo(60);
      expect(read(300)).toBeCloseTo(120);
      const rx = planOf(resolveDim([pick(ents, 7, 0), pick(ents, 2.5, 2.5 * Math.sqrt(3))], { reflex: true }));
      expect(rx.measure(at(rx, ...polar(5, 30)))).toBeCloseTo(300);
    });

    it(`solving 45 keeps the cursor's wedge at 45 (${name})`, async () => {
      const p = planOf(resolveDim([pick(ents, 7, 0), pick(ents, 2.5, 2.5 * Math.sqrt(3))]));
      for (const deg of [30, 120]) {
        const c = p.make(45, at(p, ...polar(5, deg)));
        const r = await compileAndSolve(ents, [{ type: "fix", e: "l1", p: 0 }, { type: "fix", e: "l1", p: 1 }, c]);
        expect(r.ok).toBe(true);
        const k = c as Extract<SketchConstraint, { type: "angle" }>;
        const s1 = lineOf(r.entities, k.l1),
          s2 = lineOf(r.entities, k.l2);
        expect(measuredAngleDeg(s1, s2, k.rays)).toBeCloseTo(45, 4);
        // the wedge the cursor sat in still holds the cursor's direction
        const l2 = lineOf(r.entities, "l2");
        const dirs = [Math.atan2(l2.y2 - l2.y1, l2.x2 - l2.x1), Math.atan2(l2.y1 - l2.y2, l2.x1 - l2.x2)].map(
          (a) => ((a * 180) / Math.PI + 360) % 360,
        );
        expect(dirs.some((d) => Math.abs(d - (deg === 30 ? 45 : 135)) < 1e-3)).toBe(true);
      }
    });
  }

  it("an old signed angle with no rays solves exactly as before", async () => {
    const r = await compileAndSolve(drawn, [
      { type: "fix", e: "l1", p: 0 },
      { type: "fix", e: "l1", p: 1 },
      { type: "angle", l1: "l1", l2: "l2", value: -120 },
    ]);
    const l2 = lineOf(r.entities, "l2");
    expect((Math.atan2(l2.y2 - l2.y1, l2.x2 - l2.x1) * 180) / Math.PI).toBeCloseTo(-120, 4);
  });

  it("draws an arc with extension lines", () => {
    const ents = [line("l1", 0, 0, 10, 0), line("l2", 0, 0, 5, 5 * Math.sqrt(3))];
    const p = planOf(resolveDim([pick(ents, 7, 0), pick(ents, 2.5, 2.5 * Math.sqrt(3))]));
    const c = p.make(60, at(p, ...polar(20, 30)));
    const [d] = constraintDims(ents, [c]);
    expect(d!.lines.length).toBeGreaterThan(10);
    // the arc runs at radius 20, beyond both 10 mm lines, so each gets an extension line
    const onArc = d!.lines.filter(([a, b]) => Math.abs(a.length() - 20) < 1e-6 && Math.abs(b.length() - 20) < 1e-6);
    expect(onArc.length).toBeGreaterThan(5);
    const ext = d!.lines.filter(([a, b]) => Math.abs(a.length() - 10) < 1e-6 && Math.abs(b.length() - 20) < 1e-6);
    expect(ext.length).toBe(2);
  });
});

describe("axis dims render along their axis", () => {
  it("a horizontal distance has a horizontal dimension line and vertical extension lines", () => {
    const ents = [line("a", 0, 0, 30, 40)];
    const c: SketchConstraint = {
      type: "hDistance",
      e1: "a",
      p1: 0,
      e2: "a",
      p2: 1,
      value: 30,
      place: { ox: 0, oy: 40 },
    };
    const [d] = constraintDims(ents, [c]);
    const [e1, e2, dim] = d!.lines;
    expect(dim![0].y).toBeCloseTo(60);
    expect(dim![1].y).toBeCloseTo(60);
    expect(e1![0].x).toBeCloseTo(e1![1].x);
    expect(e2![0].x).toBeCloseTo(e2![1].x);
    expect(d!.labelPos.x).toBeCloseTo(15);
    expect(d!.place!.y).toBeCloseTo(40);
  });
});

describe("radius and diameter labels go where they are dragged", () => {
  it("a radius label can sit outside the rim, with the radial line run out to it", () => {
    const ents: ResolvedEntity[] = [{ type: "circle", id: "c", x: 0, y: 0, radius: 5 }];
    const [d] = constraintDims(ents, [{ type: "radius", e: "c", value: 5, place: { ox: 8, oy: 0 } }]);
    expect(d!.labelPos.x).toBeCloseTo(8);
    expect(Math.max(...d!.lines.flat().map((q) => q.x))).toBeCloseTo(8);
  });

  it("an arc diameter is placeable and its label follows the place", () => {
    const ents: ResolvedEntity[] = [{ type: "arc", id: "r", x1: 5, y1: 0, x2: -5, y2: 0, mx: 0, my: 5 }];
    const p = planOf(resolveDim([pick(ents, 0, 5)], { roundPref: "diameter" }));
    expect(p.labelAnchor()).not.toBeNull();
    const c = p.make(10, { ox: 0, oy: -9 });
    expect(c).toEqual({ type: "diameter", circle: "r", value: 10, place: { ox: 0, oy: -9 } });
    const [d] = constraintDims(ents, [c]);
    expect(d!.place).toBeDefined();
    expect(d!.labelPos.y).toBeCloseTo(-9);
    // pointing down, off the upper half arc, so a rim extension runs to it
    expect(d!.lines.some(([a]) => a.y < -1e-6 && Math.abs(a.length() - 5) < 1e-6)).toBe(true);
  });
});

describe("without the solver", () => {
  it("a same line horizontal distance moves the free end along x only", () => {
    const ents = [line("a", 0, 0, 30, 40)];
    const changed = applyDrivingDimsDirect(ents, [{ type: "hDistance", e1: "a", p1: 0, e2: "a", p2: 1, value: 20 }]);
    expect(changed).toBe(true);
    expect(ents[0]).toMatchObject({ x1: 0, y1: 0, x2: 20, y2: 40 });
  });

  it("a two entity one is left for the solver and counted so the user is told", () => {
    const ents = [line("a", 0, 0, 0, 10), line("b", 30, 0, 30, 10)];
    const cons: SketchConstraint[] = [{ type: "hDistance", e1: "a", p1: 0, e2: "b", p2: 0, value: 12 }];
    expect(applyDrivingDimsDirect(ents, cons)).toBe(false);
    expect(waitsForSolver(ents, cons)).toBe(1);
    expect(waitsForSolver(ents, [{ type: "hDistance", e1: "a", p1: 0, e2: "a", p2: 1, value: 5 }])).toBe(0);
  });
});
