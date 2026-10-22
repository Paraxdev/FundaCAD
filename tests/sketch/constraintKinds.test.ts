// One solve per user constraint kind on slanted geometry away from the origin, against the real planegcs.
// Every row is fully defined (dof 0), so the solved coordinates are unique.
import { describe, it, expect, vi } from "vitest";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve } from "../../src/sketch/sketchSolve";
import { arcAt, circle, line, near, pc, pl, pt } from "./solveFixtures";

const s5 = Math.sqrt(5);
// A runs along (2,1) from (102,51), its unit normal is (-1,2)/sqrt5
const A = pl("A", 102, 51, 112, 56);
const p = pt("p", 104, 52);
const C = pc("C", 130, 60, 5);
const Rp = arcAt("Rp", 150, 60, 5, -0.4, 2.2, true);
// a user arc about (130,70) whose ends ride g1 and g2, so a radius alone fixes it
const g1 = pl("g1", 130, 70, 140, 75), g2 = pl("g2", 130, 70, 127, 76);
const G1 = Math.atan2(1, 2), G2 = Math.atan2(2, -1);
const arcR = (r: number) => arcAt("a", 130, 70, r, G1, G2);
const onG: SketchConstraint[] = [{ type: "fix", e: "a", p: 2 }, { type: "pointOnCurve", e: "a", p: 0, curve: "g1" }, { type: "pointOnCurve", e: "a", p: 1, curve: "g2" }];
const fixP: SketchConstraint = { type: "fix", e: "p", p: 0 };
const fixB0: SketchConstraint = { type: "fix", e: "b", p: 0 };
const T = pl("T", 120, 80, 140, 85);
const tangentToT = 250 / Math.sqrt(425);

type Row = [name: string, ents: ResolvedEntity[], cons: SketchConstraint[], moved: ResolvedEntity[]];
const rows: Row[] = [
  ["horizontal", [line("b", 103, 52, 111, 55)], [fixB0, { type: "horizontal", line: "b" }, { type: "distance", line: "b", value: 8 }], [line("b", 103, 52, 111, 52)]],
  ["vertical", [line("b", 103, 52, 106, 60)], [fixB0, { type: "vertical", line: "b" }, { type: "distance", line: "b", value: 8 }], [line("b", 103, 52, 103, 60)]],
  ["parallel", [A, line("b", 104, 60, 110, 61)], [fixB0, { type: "parallel", l1: "A", l2: "b" }, { type: "distance", line: "b", value: 5 * s5 }], [line("b", 104, 60, 114, 65)]],
  ["perpendicular", [A, line("b", 120, 50, 122, 56)], [fixB0, { type: "perpendicular", l1: "A", l2: "b" }, { type: "distance", line: "b", value: 5 * s5 }], [line("b", 120, 50, 115, 60)]],
  ["equal", [A, line("b", 104, 60, 110, 60.5)], [fixB0, { type: "horizontal", line: "b" }, { type: "equal", l1: "A", l2: "b" }], [line("b", 104, 60, 104 + 5 * s5, 60)]],
  ["distance", [line("b", 104, 60, 105, 66)], [fixB0, { type: "vertical", line: "b" }, { type: "distance", line: "b", value: 7 }], [line("b", 104, 60, 104, 67)]],
  ["p2pDistance", [p, pt("q", 110, 58)], [fixP, { type: "hDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: 3 }, { type: "p2pDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: 5 }], [pt("q", 107, 56)]],
  ["hDistance and vDistance, signed", [p, pt("q", 100, 57)], [fixP, { type: "hDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: -3 }, { type: "vDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: 4 }], [pt("q", 101, 56)]],
  ["p2lDistance", [A, p, pt("q", 106, 60)], [fixP, { type: "hDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: 2 }, { type: "p2lDistance", e: "q", p: 0, line: "A", value: 4 }], [pt("q", 106, 53 + 2 * s5)]],
  ["diameter on a circle", [circle("c", 130, 60, 4)], [{ type: "fix", e: "c", p: 0 }, { type: "diameter", circle: "c", value: 11 }], [circle("c", 130, 60, 5.5)]],
  ["diameter on an arc", [g1, g2, arcR(4.5)], [...onG, { type: "diameter", circle: "a", value: 12 }], [arcR(6)]],
  ["radius on a circle", [circle("c", 130, 60, 4)], [{ type: "fix", e: "c", p: 1 }, { type: "radius", e: "c", value: 5 }], [circle("c", 130, 60, 5)]],
  ["radius on an arc", [g1, g2, arcR(4.5)], [...onG, { type: "radius", e: "a", value: 7 }], [arcR(7)]],
  ["angle", [A, line("b", 120, 50, 121, 55)], [fixB0, { type: "distance", line: "b", value: 5 }, { type: "angle", l1: "A", l2: "b", value: 60 }],
    [line("b", 120, 50, 120 + 5 * Math.cos(G1 + Math.PI / 3), 50 + 5 * Math.sin(G1 + Math.PI / 3))]],
  ["coincident", [A, line("b", 105, 58, 115, 62)], [{ type: "fix", e: "b", p: 1 }, { type: "coincident", e1: "b", p1: 0, e2: "A", p2: 1 }], [line("b", 112, 56, 115, 62)]],
  ["horizontalPoints", [p, pt("q", 110, 58)], [fixP, { type: "horizontalPoints", e1: "p", p1: 0, e2: "q", p2: 0 }, { type: "p2pDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: 5 }], [pt("q", 109, 52)]],
  ["verticalPoints", [p, pt("q", 106, 58)], [fixP, { type: "verticalPoints", e1: "p", p1: 0, e2: "q", p2: 0 }, { type: "p2pDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: 5 }], [pt("q", 104, 57)]],
  ["midpoint", [A, pt("q", 108, 55)], [{ type: "midpoint", e: "q", p: 0, line: "A" }], [pt("q", 107, 53.5)]],
  ["pointOnCurve on a line", [A, p, pt("q", 108, 57)], [fixP, { type: "hDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: 4 }, { type: "pointOnCurve", e: "q", p: 0, curve: "A" }], [pt("q", 108, 54)]],
  ["pointOnCurve on a circle", [C, pt("q", 136, 64)], [{ type: "hDistance", e1: "C", p1: 0, e2: "q", p2: 0, value: 3 }, { type: "pointOnCurve", e: "q", p: 0, curve: "C" }], [pt("q", 133, 64)]],
  ["pointOnCurve on an arc", [Rp, pt("q", 154, 64)], [{ type: "hDistance", e1: "Rp", p1: 2, e2: "q", p2: 0, value: 3 }, { type: "pointOnCurve", e: "q", p: 0, curve: "Rp" }], [pt("q", 153, 64)]],
  ["concentric", [C, circle("c", 131, 62, 3)], [{ type: "radius", e: "c", value: 3 }, { type: "concentric", c1: "c", c2: "C" }], [circle("c", 130, 60, 3)]],
  ["tangent, line to circle", [A, circle("c", 110, 60, 3)], [{ type: "fix", e: "c", p: 0 }, { type: "tangent", line: "A", circle: "c" }], [circle("c", 110, 60, 2 * s5)]],
  ["tangent2, line then circle", [A, circle("c", 110, 60, 3)], [{ type: "fix", e: "c", p: 0 }, { type: "tangent2", a: "A", b: "c" }], [circle("c", 110, 60, 2 * s5)]],
  ["tangent2, circle then line", [A, circle("c", 110, 60, 3)], [{ type: "fix", e: "c", p: 0 }, { type: "tangent2", a: "c", b: "A" }], [circle("c", 110, 60, 2 * s5)]],
  ["tangent2, line then arc", [g1, g2, T, arcR(11)], [...onG, { type: "tangent2", a: "T", b: "a" }], [arcR(tangentToT)]],
  ["tangent2, arc then line", [g1, g2, T, arcR(11)], [...onG, { type: "tangent2", a: "a", b: "T" }], [arcR(tangentToT)]],
  ["tangent2, circle to circle", [C, circle("c", 140, 66, 6)], [{ type: "fix", e: "c", p: 0 }, { type: "tangent2", a: "C", b: "c" }], [circle("c", 140, 66, Math.sqrt(136) - 5)]],
  ["tangent2, circle then arc", [Rp, circle("c", 138, 54, 8)], [{ type: "fix", e: "c", p: 0 }, { type: "tangent2", a: "c", b: "Rp" }], [circle("c", 138, 54, Math.sqrt(180) - 5)]],
  ["tangent2, arc then circle", [Rp, circle("c", 138, 54, 8)], [{ type: "fix", e: "c", p: 0 }, { type: "tangent2", a: "Rp", b: "c" }], [circle("c", 138, 54, Math.sqrt(180) - 5)]],
  ["tangent2, arc to arc", [g1, g2, Rp, arcR(16)], [...onG, { type: "tangent2", a: "a", b: "Rp" }], [arcR(Math.sqrt(500) - 5)]],
  ["equalRadius, circle to circle", [C, circle("c", 140, 66, 6)], [{ type: "fix", e: "c", p: 0 }, { type: "equalRadius", a: "c", b: "C" }], [circle("c", 140, 66, 5)]],
  ["equalRadius, circle then arc", [Rp, circle("c", 138, 54, 7)], [{ type: "fix", e: "c", p: 0 }, { type: "equalRadius", a: "c", b: "Rp" }], [circle("c", 138, 54, 5)]],
  ["equalRadius, arc then circle", [Rp, circle("c", 138, 54, 7)], [{ type: "fix", e: "c", p: 0 }, { type: "equalRadius", a: "Rp", b: "c" }], [circle("c", 138, 54, 5)]],
  ["equalRadius, arc to arc", [g1, g2, Rp, arcR(7)], [...onG, { type: "equalRadius", a: "a", b: "Rp" }], [arcR(5)]],
  // (104,58) mirrored across A is (108.8,48.4)
  ["symmetric", [A, pt("m", 104, 58), pt("q", 109, 49)], [{ type: "fix", e: "m", p: 0 }, { type: "symmetric", e1: "m", p1: 0, e2: "q", p2: 0, line: "A" }], [pt("q", 108.8, 48.4)]],
  ["collinear", [A, line("b", 114, 58, 122, 61)], [{ type: "hDistance", e1: "A", p1: 1, e2: "b", p2: 0, value: 3 }, { type: "collinear", l1: "A", l2: "b" }, { type: "distance", line: "b", value: 5 }],
    [line("b", 115, 57.5, 115 + 2 * s5, 57.5 + s5)]],
  ["collinear, sharing an end", [A, line("b", 112, 56, 120, 62)], [{ type: "collinear", l1: "A", l2: "b" }, { type: "distance", line: "b", value: 5 }], [line("b", 112, 56, 112 + 2 * s5, 56 + s5)]],
  ["c2cDistance", [C, circle("c", 138, 65, 3)], [{ type: "radius", e: "c", value: 3 }, { type: "vDistance", e1: "C", p1: 0, e2: "c", p2: 0, value: 4 }, { type: "c2cDistance", c1: "C", c2: "c", value: 2 }],
    [circle("c", 130 + Math.sqrt(84), 64, 3)]],
  ["c2lDistance", [A, p, circle("c", 110, 60, 2)], [fixP, { type: "radius", e: "c", value: 2 }, { type: "hDistance", e1: "p", p1: 0, e2: "c", p2: 0, value: 6 }, { type: "c2lDistance", circle: "c", line: "A", value: 3 }],
    [circle("c", 110, 55 + 2.5 * s5, 2)]],
  ["p2cDistance", [C, pt("q", 133.5, 66)], [{ type: "hDistance", e1: "C", p1: 0, e2: "q", p2: 0, value: 3 }, { type: "p2cDistance", e: "q", p: 0, circle: "C", value: 2 }], [pt("q", 133, 60 + Math.sqrt(40))]],
  ["radialGap", [C, circle("c", 130.5, 60.5, 3)], [{ type: "fix", e: "c", p: 0 }, { type: "radialGap", inner: "c", outer: "C", value: 1.5 }], [circle("c", 130.5, 60.5, 3.5)]],
  ...[3, -3].map((value): Row => [`offset of a line by ${value}`, [A, p, line("b", 110, 59, 117, 62)],
    [fixP, { type: "hDistance", e1: "p", p1: 0, e2: "b", p2: 0, value: 6 }, { type: "distance", line: "b", value: 8 }, { type: "offset", pairs: [{ src: "A", cpy: "b" }], value }],
    [line("b", 110, 55 + 1.5 * s5, 110 + 16 / s5, 55 + 1.5 * s5 + 8 / s5)]]),
  ["offset of a circle", [C, circle("c", 131, 61, 6)], [{ type: "offset", pairs: [{ src: "C", cpy: "c" }], value: 2 }], [circle("c", 130, 60, 7)]],
];

describe("every constraint kind solves to its unique answer", () => {
  it.each(rows)("%s", async (_name, ents, cons, moved) => {
    const byId = new Map(moved.map((e) => [e.id, e]));
    const r = await compileAndSolve(ents, cons);
    expect(r).toEqual(near({ entities: ents.map((e) => byId.get(e.id) ?? e), dof: 0, ok: true, conflicts: [], overDefined: [] }));
  });
});

describe("planegcs diagnoses reach the result", () => {
  const b = line("b", 104, 60, 110, 63);
  it("names both of two contradicting lengths and fails the solve", async () => {
    const r = await compileAndSolve([b], [{ type: "distance", line: "b", value: 10 }, { type: "distance", line: "b", value: 20 }]);
    expect({ ok: r.ok, conflicts: [...r.conflicts].sort(), overDefined: r.overDefined }).toEqual({ ok: false, conflicts: ["k0", "k1"], overDefined: [] });
  });

  // Both start satisfied: when a redundant set has to move geometry, planegcs does not report Success and ok is false.
  it("names a doubled horizontal as over-defined and still solves", async () => {
    const h = line("b", 104, 60, 110, 60);
    const r = await compileAndSolve([h], [{ type: "horizontal", line: "b" }, { type: "horizontal", line: "b" }]);
    expect(r).toEqual(near({ entities: [h], dof: 3, ok: true, conflicts: [], overDefined: ["k1"] }));
  });

  it("names the third of three dims that agree on one point as over-defined", async () => {
    const q = pt("q", 107, 56);
    const r = await compileAndSolve([p, q], [fixP, { type: "hDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: 3 },
      { type: "vDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: 4 }, { type: "p2pDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: 5 }]);
    expect(r).toEqual(near({ entities: [p, q], dof: 0, ok: true, conflicts: [], overDefined: ["k3"] }));
  });
});

describe("a constraint naming the wrong kind of entity is left out", () => {
  // the parallel row of the table plus a free circle F held by its own radius, so every row keeps dof 0
  const ents = [A, line("b", 104, 60, 110, 61), circle("F", 120, 40, 3), Rp, pt("q", 90, 45)];
  const base: SketchConstraint[] = [fixB0, { type: "parallel", l1: "A", l2: "b" }, { type: "distance", line: "b", value: 5 * s5 },
    { type: "fix", e: "F", p: 0 }, { type: "radius", e: "F", value: 4 }, { type: "fix", e: "q", p: 0 }];
  const want = near({ entities: [A, line("b", 104, 60, 114, 65), circle("F", 120, 40, 4), Rp, pt("q", 90, 45)], dof: 0, ok: true, conflicts: [], overDefined: [] });
  const bad = [
    { type: "parallel", l1: "b", l2: "F" }, { type: "parallel", l1: "b", l2: "gone" }, { type: "perpendicular", l1: "F", l2: "b" }, { type: "equal", l1: "b", l2: "Rp" },
    { type: "horizontal", line: "F" }, { type: "vertical", line: "Rp" }, { type: "distance", line: "F", value: 3 },
    { type: "p2pDistance", e1: "b", p1: 1, e2: "b", p2: 1, value: 3 }, { type: "hDistance", e1: "b", p1: 1, e2: "b", p2: 1, value: 3 },
    { type: "p2lDistance", e: "b", p: 1, line: "F", value: 3 }, { type: "diameter", circle: "b", value: 3 },
    { type: "radialGap", inner: "b", outer: "F", value: 1 }, { type: "radialGap", inner: "F", outer: "F", value: 1 },
    { type: "c2cDistance", c1: "F", c2: "b", value: 1 }, { type: "c2cDistance", c1: "F", c2: "F", value: 1 },
    { type: "c2lDistance", circle: "b", line: "F", value: 1 }, { type: "c2lDistance", circle: "F", line: "F", value: 1 }, { type: "p2cDistance", e: "b", p: 1, circle: "b", value: 1 },
    { type: "tangent", line: "b", circle: "Rp" }, { type: "tangent", line: "F", circle: "F" },
    { type: "coincident", e1: "b", p1: 1, e2: "gone", p2: 0 }, { type: "concentric", c1: "b", c2: "F" }, { type: "midpoint", e: "b", p: 1, line: "F" },
    { type: "pointOnCurve", e: "b", p: 1, curve: "gone" }, { type: "pointOnCurve", e: "b", p: 1, curve: "q" }, { type: "symmetric", e1: "b", p1: 1, e2: "q", p2: 0, line: "F" },
    { type: "angle", l1: "F", l2: "b", value: 30 }, { type: "radius", e: "b", value: 2 }, { type: "collinear", l1: "b", l2: "F" },
    { type: "equalRadius", a: "b", b: "F" }, { type: "equalRadius", a: "F", b: "b" }, { type: "equalRadius", a: "Rp", b: "b" }, { type: "equalRadius", a: "b", b: "Rp" }, { type: "equalRadius", a: "q", b: "F" },
    { type: "tangent2", a: "b", b: "b" }, { type: "tangent2", a: "q", b: "F" }, { type: "tangent2", a: "F", b: "q" }, { type: "tangent2", a: "Rp", b: "q" }, { type: "tangent2", a: "q", b: "Rp" }, { type: "tangent2", a: "b", b: "q" },
    { type: "offset", pairs: [{ src: "F", cpy: "b" }], value: 2 }, { type: "offset", pairs: [{ src: "b", cpy: "F" }], value: 2 }, { type: "offset", pairs: [{ src: "F", cpy: "F" }], value: 2 },
  ] as SketchConstraint[];

  it.each(bad.map((c) => [JSON.stringify(c), c] as const))("%s", async (_n, c) => {
    expect(await compileAndSolve(ents, [...base, c])).toEqual(want);
  });
});
