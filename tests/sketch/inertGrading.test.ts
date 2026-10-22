// Grading of constraints whose operands are all fixed (projected or `fix`): satisfied is amber (overDefined),
// violated is red (conflicts, ok false), and a constraint with a free operand is left to planegcs.
import { describe, it, expect, vi } from "vitest";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve } from "../../src/sketch/sketchSolve";
import { arc, circle, line, near, pa, pc, pl, pt } from "./solveFixtures";

// The scene is laid out in local coordinates, then turned by atan2(3,4) and moved to (100,50).
const R = (x: number, y: number): [number, number] => [100 + 0.8 * x - 0.6 * y, 50 + 0.6 * x + 0.8 * y];
const PL = (id: string, x1: number, y1: number, x2: number, y2: number) => pl(id, ...R(x1, y1), ...R(x2, y2));
const PC = (id: string, x: number, y: number, r: number) => pc(id, ...R(x, y), r);
const upper = (cx: number, cy: number, r: number) => [...R(cx + r, cy), ...R(cx - r, cy), ...R(cx, cy + r)] as const;
const PA = (id: string, cx: number, cy: number, r: number) => pa(id, ...upper(cx, cy, r));
const PT = (id: string, x: number, y: number) => pt(id, ...R(x, y));
const LN = (id: string, x1: number, y1: number, x2: number, y2: number) => line(id, ...R(x1, y1), ...R(x2, y2));
const CI = (id: string, x: number, y: number, r: number) => circle(id, ...R(x, y), r);
const AR = (id: string, cx: number, cy: number, r: number) => arc(id, ...upper(cx, cy, r));

// Lines and points only: with no free parameter in the sketch, planegcs grades nothing and the result is ours alone.
const LINES: ResolvedEntity[] = [
  PL("L1", 0, 0, 10, 0), PL("L2", 0, 5, 10, 5), PL("L3", 0, 0, 0, 10), PL("L4", 0, -3, 4, -3), PL("L5", 0, 8, 10, 8), PL("L6", 20, 0, 30, 0),
  PL("L7", 2, 1, 6, 4), PL("L8", 10, 0, 7, 4), PL("L9", 10, -6, 0, -6), PL("L11", 10, 0, 15, 0),
  PT("p", 5, 5), PT("q", 6, 5), PT("r4", 4, 5), PT("m1", 2, 1), PT("m2", 2, -1), PT("m3", 3, -1), PT("m4", 7, 2), PT("f1", 0.1, 0.2), PT("f2", 0.4, 0.6),
];
const LINES_FIXED = ["p", "q", "r4", "m1", "m2", "m3", "m4", "f1", "f2"];
// A round's radius is a planegcs parameter, so planegcs sees these constraints too and adds its own implicit ids.
const ROUNDS: ResolvedEntity[] = [
  PL("L1", 0, 0, 10, 0), PL("L2", 0, 5, 10, 5), PL("L5", 0, 8, 10, 8),
  PC("C1", 20, 0, 5), PC("C2", 30, 0, 5), PC("C3", 40, 40, 5), PC("C4", 22, 0, 3), PC("C5", 21, 0, 2), PC("C6", 26, 0, 3),
  PA("A1", 50, 0, 5), PA("A2", 40, 0, 5), PA("A3", 50, 20, 3),
  PT("s", 25, 0), PT("u", 24, 0), PT("w", 50, -5), PT("z", 50, 4), PT("o", 28, 0), PT("i", 21, 1),
];
const ROUNDS_FIXED = ["s", "u", "w", "z", "o", "i"];
const SCENE = [...LINES, ...ROUNDS.filter((e) => !LINES.some((l) => l.id === e.id))];
const FIXED = [...LINES_FIXED, ...ROUNDS_FIXED];
// the same kinds of rows for the axis constraints, which a turn would break, only moved
const AXIS: ResolvedEntity[] = [pl("H1", 100, 50, 110, 50), pl("V1", 100, 50, 100, 60), pl("S1", 100, 50, 108, 56), pt("hp", 105, 55), pt("hq", 106, 55), pt("hr", 106, 58)];
const AXIS_FIXED = ["hp", "hq", "hr"];

type Grade = "amber" | "red";
const C = (c: object) => c as SketchConstraint;
const fixes = (ids: string[]) => ids.map((e): SketchConstraint => ({ type: "fix", e, p: 0 }));

async function graded(ents: ResolvedEntity[], fixed: string[], c: SketchConstraint, amber: string[], red: string[]) {
  expect(await compileAndSolve(ents, [c, ...fixes(fixed)])).toEqual(near({ entities: ents, dof: 0, ok: red.length === 0, conflicts: red, overDefined: amber }));
}
// what the sketcher acts on: the user keys it colours, and whether the solve is refused
async function gradedRound(c: SketchConstraint, amber: string[], red: string[]) {
  const r = await compileAndSolve(ROUNDS, [c, ...fixes(ROUNDS_FIXED)]);
  const user = (ids: string[]) => ids.filter((id) => id.startsWith("k"));
  expect({ entities: r.entities, conflicts: user(r.conflicts), overDefined: user(r.overDefined), refused: !r.ok || r.conflicts.length > 0 })
    .toEqual(near({ entities: ROUNDS, conflicts: red, overDefined: amber, refused: red.length > 0 }));
}
const rowsOf = (list: [SketchConstraint, Grade][]) => list.map(([c, g]) => [`${g} ${JSON.stringify(c)}`, c, g] as const);

const turnedLines: [SketchConstraint, Grade][] = [
  [C({ type: "coincident", e1: "p", p1: 0, e2: "q", p2: 0 }), "red"], [C({ type: "parallel", l1: "L1", l2: "L2" }), "amber"], [C({ type: "parallel", l1: "L3", l2: "L1" }), "red"],
  [C({ type: "perpendicular", l1: "L1", l2: "L3" }), "amber"], [C({ type: "perpendicular", l1: "L7", l2: "L8" }), "amber"], [C({ type: "perpendicular", l1: "L1", l2: "L9" }), "red"],
  [C({ type: "equal", l1: "L1", l2: "L2" }), "amber"], [C({ type: "equal", l1: "L4", l2: "L1" }), "red"], [C({ type: "distance", line: "L1", value: 10 }), "amber"],
  [C({ type: "distance", line: "L1", value: 11 }), "red"], [C({ type: "p2pDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: 1 }), "amber"],
  [C({ type: "p2pDistance", e1: "p", p1: 0, e2: "q", p2: 0, value: 1.5 }), "red"], [C({ type: "p2pDistance", e1: "f1", p1: 0, e2: "f2", p2: 0, value: 0.5 }), "amber"],
  [C({ type: "p2pDistance", e1: "f1", p1: 0, e2: "f2", p2: 0, value: 0.50000001 }), "amber"], [C({ type: "p2lDistance", e: "p", p: 0, line: "L1", value: 5 }), "amber"],
  [C({ type: "p2lDistance", e: "p", p: 0, line: "L1", value: 6 }), "red"], [C({ type: "p2lDistance", e: "p", p: 0, line: "L3", value: 5 }), "amber"],
  [C({ type: "angle", l1: "L1", l2: "L3", value: 90 }), "amber"], [C({ type: "angle", l1: "L1", l2: "L3", value: 45 }), "red"],
  [C({ type: "angle", l1: "L1", l2: "L3", value: 120 }), "red"], [C({ type: "angle", l1: "L3", l2: "L1", value: -90 }), "amber"],
  [C({ type: "angle", l1: "L3", l2: "L1", value: 90 }), "red"], [C({ type: "angle", l1: "L1", l2: "L2", value: 0 }), "amber"],
  [C({ type: "angle", l1: "L1", l2: "L9", value: 180 }), "amber"], [C({ type: "angle", l1: "L1", l2: "L6", value: 180 }), "red"],
  [C({ type: "pointOnCurve", e: "p", p: 0, curve: "L2" }), "amber"], [C({ type: "pointOnCurve", e: "p", p: 0, curve: "L1" }), "red"],
  [C({ type: "symmetric", e1: "m1", p1: 0, e2: "m2", p2: 0, line: "L1" }), "amber"], [C({ type: "symmetric", e1: "m1", p1: 0, e2: "m3", p2: 0, line: "L1" }), "red"],
  [C({ type: "symmetric", e1: "p", p1: 0, e2: "q", p2: 0, line: "L3" }), "red"],
];

const turnedRounds: [SketchConstraint, Grade][] = [
  [C({ type: "diameter", circle: "C1", value: 10 }), "amber"], [C({ type: "diameter", circle: "C1", value: 11 }), "red"], [C({ type: "diameter", circle: "A1", value: 10 }), "amber"],
  [C({ type: "diameter", circle: "A1", value: 12 }), "red"], [C({ type: "radius", e: "C1", value: 5 }), "amber"], [C({ type: "radius", e: "C1", value: 6 }), "red"],
  [C({ type: "radius", e: "A1", value: 5 }), "amber"], [C({ type: "radius", e: "A1", value: 6 }), "red"], [C({ type: "tangent", line: "L2", circle: "C1" }), "amber"],
  [C({ type: "tangent", line: "L1", circle: "C1" }), "red"], [C({ type: "tangent2", a: "C1", b: "L2" }), "amber"], [C({ type: "tangent2", a: "L2", b: "A1" }), "amber"],
  [C({ type: "tangent2", a: "A1", b: "L1" }), "red"], [C({ type: "tangent2", a: "C1", b: "C2" }), "amber"], [C({ type: "tangent2", a: "C1", b: "C4" }), "amber"],
  [C({ type: "tangent2", a: "C4", b: "C1" }), "amber"], [C({ type: "tangent2", a: "C1", b: "C3" }), "red"], [C({ type: "tangent2", a: "C1", b: "C6" }), "red"],
  [C({ type: "tangent2", a: "C1", b: "C5" }), "red"], [C({ type: "tangent2", a: "C2", b: "A2" }), "amber"], [C({ type: "tangent2", a: "A2", b: "C3" }), "red"],
  [C({ type: "tangent2", a: "A1", b: "A2" }), "amber"], [C({ type: "tangent2", a: "A1", b: "A3" }), "red"], [C({ type: "equalRadius", a: "C1", b: "C2" }), "amber"],
  [C({ type: "equalRadius", a: "C4", b: "C1" }), "red"], [C({ type: "equalRadius", a: "C1", b: "A1" }), "amber"], [C({ type: "equalRadius", a: "A1", b: "C1" }), "amber"],
  [C({ type: "equalRadius", a: "C4", b: "A1" }), "red"], [C({ type: "equalRadius", a: "A1", b: "A2" }), "amber"], [C({ type: "equalRadius", a: "A3", b: "A1" }), "red"],
  [C({ type: "pointOnCurve", e: "s", p: 0, curve: "C1" }), "amber"], [C({ type: "pointOnCurve", e: "u", p: 0, curve: "C1" }), "red"],
  [C({ type: "pointOnCurve", e: "w", p: 0, curve: "A1" }), "amber"], [C({ type: "pointOnCurve", e: "z", p: 0, curve: "A1" }), "red"],
  [C({ type: "c2cDistance", c1: "C1", c2: "C3", value: Math.hypot(20, 40) - 10 }), "amber"], [C({ type: "c2cDistance", c1: "C1", c2: "C3", value: 40 }), "red"],
  [C({ type: "c2cDistance", c1: "C1", c2: "C5", value: 2 }), "amber"], [C({ type: "c2cDistance", c1: "C5", c2: "C1", value: 2 }), "amber"], [C({ type: "c2cDistance", c1: "C1", c2: "C5", value: 3 }), "red"],
  [C({ type: "c2lDistance", circle: "C1", line: "L5", value: 3 }), "amber"], [C({ type: "c2lDistance", circle: "C1", line: "L5", value: 4 }), "red"],
  [C({ type: "p2cDistance", e: "o", p: 0, circle: "C1", value: 3 }), "amber"], [C({ type: "p2cDistance", e: "o", p: 0, circle: "C1", value: 4 }), "red"],
  [C({ type: "p2cDistance", e: "i", p: 0, circle: "C1", value: 5 - Math.SQRT2 }), "amber"], [C({ type: "radialGap", inner: "C4", outer: "C1", value: 2 }), "amber"],
  [C({ type: "radialGap", inner: "C4", outer: "C1", value: 3 }), "red"],
];

const axis: [SketchConstraint, Grade][] = [
  [C({ type: "horizontal", line: "H1" }), "amber"], [C({ type: "horizontal", line: "S1" }), "red"], [C({ type: "horizontal", line: "V1" }), "red"],
  [C({ type: "vertical", line: "V1" }), "amber"], [C({ type: "vertical", line: "S1" }), "red"], [C({ type: "vertical", line: "H1" }), "red"],
  [C({ type: "hDistance", e1: "hp", p1: 0, e2: "hq", p2: 0, value: 1 }), "amber"], [C({ type: "hDistance", e1: "hq", p1: 0, e2: "hp", p2: 0, value: 1 }), "red"],
  [C({ type: "hDistance", e1: "hp", p1: 0, e2: "hq", p2: 0, value: 2 }), "red"],
  [C({ type: "vDistance", e1: "hp", p1: 0, e2: "hr", p2: 0, value: 3 }), "amber"], [C({ type: "vDistance", e1: "hp", p1: 0, e2: "hr", p2: 0, value: 4 }), "red"],
  [C({ type: "horizontalPoints", e1: "hp", p1: 0, e2: "hq", p2: 0 }), "amber"], [C({ type: "verticalPoints", e1: "hq", p1: 0, e2: "hp", p2: 0 }), "red"],
  [C({ type: "verticalPoints", e1: "hq", p1: 0, e2: "hr", p2: 0 }), "amber"], [C({ type: "horizontalPoints", e1: "hr", p1: 0, e2: "hq", p2: 0 }), "red"],
];

describe("a constraint between fixed operands is graded by its residual", () => {
  it.each(rowsOf(turnedLines))("%s", (_n, c, g) => graded(LINES, LINES_FIXED, c, g === "amber" ? ["k0"] : [], g === "red" ? ["k0"] : []));
  it.each(rowsOf(turnedRounds))("%s", (_n, c, g) => gradedRound(c, g === "amber" ? ["k0"] : [], g === "red" ? ["k0"] : []));
  it.each(rowsOf(axis))("%s", (_n, c, g) => graded(AXIS, AXIS_FIXED, c, g === "amber" ? ["k0"] : [], g === "red" ? ["k0"] : []));

  it("grades each half of a midpoint and of a collinear on its own", async () => {
    await graded(LINES, LINES_FIXED, C({ type: "midpoint", e: "p", p: 0, line: "L2" }), ["k0a", "k0b"], []);
    await graded(LINES, LINES_FIXED, C({ type: "midpoint", e: "p", p: 0, line: "L1" }), ["k0b"], ["k0a"]);
    await graded(LINES, LINES_FIXED, C({ type: "midpoint", e: "r4", p: 0, line: "L2" }), ["k0a"], ["k0b"]);
    await graded(LINES, LINES_FIXED, C({ type: "collinear", l1: "L1", l2: "L6" }), ["k0p", "k0o"], []);
    await graded(LINES, LINES_FIXED, C({ type: "collinear", l1: "L1", l2: "L2" }), ["k0p"], ["k0o"]);
    await graded(LINES, LINES_FIXED, C({ type: "collinear", l1: "L1", l2: "L11" }), ["k0o"], []);
  });

  it("grades a coincident across a merge bucket by its distance", async () => {
    // 2e-5 apart, but on either side of a 0.001 bucket edge, so they stay two points
    const ends = [pt("a", 100.00049, 57.3), pt("b", 100.00051, 57.3)];
    await graded(ends, ["a", "b"], C({ type: "coincident", e1: "a", p1: 0, e2: "b", p2: 0 }), ["k0"], []);
  });

  it("puts the tolerance itself on the amber side", async () => {
    // 0.0002 - 0.0001 is exactly 1e-4 in floats
    const ab = [pt("a", 0.0001, 57.3), pt("b", 0.0002, 50.1)];
    await graded(ab, ["a", "b"], C({ type: "hDistance", e1: "a", p1: 0, e2: "b", p2: 0, value: 0 }), ["k0"], []);
    await graded(ab, ["a", "b"], C({ type: "hDistance", e1: "a", p1: 0, e2: "b", p2: 0, value: -1e-9 }), [], ["k0"]);
  });

  it("wraps an angle residual, so 180 degrees between lines tilted either way is amber", async () => {
    for (const tilt of [1e-7, -1e-7]) {
      const ents = [pl("A", 110, 50, 100, 50), pl("B", 100, 55, 110, 55 + tilt)];
      await graded(ents, [], C({ type: "angle", l1: "A", l2: "B", value: 180 }), ["k0"], []);
    }
  });

  it("refuses a coincident between two projected ends with no free parameter left", async () => {
    const ents = [PL("A", 0, 0, 10, 0), PL("B", 11, 0, 20, 0)];
    await graded(ents, [], C({ type: "coincident", e1: "A", p1: 1, e2: "B", p2: 0 }), [], ["k0"]);
  });
});

describe("a constraint with a free operand is left to planegcs", () => {
  // each free entity starts on its constraint, so nothing moves and dof counts what is left of it
  const free: [string, ResolvedEntity, SketchConstraint, number][] = [
    ["parallel", LN("F", 0, 12, 10, 12), C({ type: "parallel", l1: "L1", l2: "F" }), 3],
    ["perpendicular", LN("F", 15, 1, 15, 11), C({ type: "perpendicular", l1: "L1", l2: "F" }), 3],
    ["equal", LN("F", 0, 12, 10, 12), C({ type: "equal", l1: "L1", l2: "F" }), 3],
    ["distance", LN("F", 0, 12, 10, 12), C({ type: "distance", line: "F", value: 10 }), 3],
    ["p2pDistance", PT("F", 5, 6), C({ type: "p2pDistance", e1: "p", p1: 0, e2: "F", p2: 0, value: 1 }), 1],
    ["p2lDistance to a free line", LN("F", 0, 12, 10, 12), C({ type: "p2lDistance", e: "p", p: 0, line: "F", value: 7 }), 3],
    ["p2lDistance of a free point", PT("F", 5, 6), C({ type: "p2lDistance", e: "F", p: 0, line: "L1", value: 6 }), 1],
    ["diameter", CI("F", 35, 10, 5), C({ type: "diameter", circle: "F", value: 10 }), 2],
    ["diameter on an arc", AR("F", 60, 10, 5), C({ type: "diameter", circle: "F", value: 10 }), 4],
    ["radius", CI("F", 35, 10, 5), C({ type: "radius", e: "F", value: 5 }), 2],
    ["radius on an arc", AR("F", 60, 10, 5), C({ type: "radius", e: "F", value: 5 }), 4],
    ["tangent", CI("F", 35, 10, 5), C({ type: "tangent", line: "L2", circle: "F" }), 2],
    ["tangent2 line to arc", AR("F", 60, 10, 5), C({ type: "tangent2", a: "L2", b: "F" }), 4],
    ["tangent2 circle to circle", CI("F", 32, 0, 7), C({ type: "tangent2", a: "C1", b: "F" }), 2],
    ["tangent2 circle to arc", CI("F", 50, -12, 7), C({ type: "tangent2", a: "F", b: "A1" }), 2],
    ["tangent2 arc to arc", AR("F", 50, 13, 8), C({ type: "tangent2", a: "A1", b: "F" }), 4],
    ["angle", LN("F", 0, 20, 10 * Math.cos(Math.PI / 6), 20 + 10 * Math.sin(Math.PI / 6)), C({ type: "angle", l1: "L1", l2: "F", value: 30 }), 3],
    ["equalRadius circles", CI("F", 35, 10, 5), C({ type: "equalRadius", a: "C1", b: "F" }), 2],
    ["equalRadius circle to arc", AR("F", 60, 10, 5), C({ type: "equalRadius", a: "C1", b: "F" }), 4],
    ["equalRadius arcs", AR("F", 60, 10, 5), C({ type: "equalRadius", a: "A1", b: "F" }), 4],
    ["pointOnCurve line", PT("F", 8, 5), C({ type: "pointOnCurve", e: "F", p: 0, curve: "L2" }), 1],
    ["pointOnCurve circle", PT("F", 20, 5), C({ type: "pointOnCurve", e: "F", p: 0, curve: "C1" }), 1],
    ["pointOnCurve arc", PT("F", 53, 4), C({ type: "pointOnCurve", e: "F", p: 0, curve: "A1" }), 1],
    ["midpoint", PT("F", 5, 8), C({ type: "midpoint", e: "F", p: 0, line: "L5" }), 0],
    ["symmetric", PT("F", 7, -2), C({ type: "symmetric", e1: "m4", p1: 0, e2: "F", p2: 0, line: "L1" }), 0],
    ["collinear", LN("F", 32, 0, 40, 0), C({ type: "collinear", l1: "L1", l2: "F" }), 2],
    ["c2cDistance", CI("F", 40, 0, 3), C({ type: "c2cDistance", c1: "C1", c2: "F", value: 12 }), 2],
    ["c2lDistance", CI("F", 35, 20, 5), C({ type: "c2lDistance", circle: "F", line: "L5", value: 7 }), 2],
    ["p2cDistance", PT("F", 28, 1), C({ type: "p2cDistance", e: "F", p: 0, circle: "C1", value: Math.sqrt(65) - 5 }), 1],
    ["radialGap", CI("F", 20.5, 0.5, 3), C({ type: "radialGap", inner: "F", outer: "C1", value: 2 }), 2],
  ];
  it.each(free)("%s", async (_n, F, c, dof) => {
    const ents = [...SCENE, F];
    expect(await compileAndSolve(ents, [c, ...fixes(FIXED)])).toEqual(near({ entities: ents, dof, ok: true, conflicts: [], overDefined: [] }));
  });

  const freeAxis: [string, ResolvedEntity, SketchConstraint][] = [
    ["horizontal", line("F", 100, 62, 110, 62), C({ type: "horizontal", line: "F" })],
    ["vertical", line("F", 115, 50, 115, 60), C({ type: "vertical", line: "F" })],
    ["hDistance", pt("F", 107, 57), C({ type: "hDistance", e1: "hp", p1: 0, e2: "F", p2: 0, value: 2 })],
    ["horizontalPoints", pt("F", 109, 55), C({ type: "horizontalPoints", e1: "hp", p1: 0, e2: "F", p2: 0 })],
    ["verticalPoints", pt("F", 105, 59), C({ type: "verticalPoints", e1: "hp", p1: 0, e2: "F", p2: 0 })],
  ];
  it.each(freeAxis)("%s", async (_n, F, c) => {
    const ents = [...AXIS, F];
    expect(await compileAndSolve(ents, [c, ...fixes(AXIS_FIXED)])).toEqual(near({ entities: ents, dof: F.type === "line" ? 3 : 1, ok: true, conflicts: [], overDefined: [] }));
  });

  it("pulls a free point onto a fixed one for a coincident", async () => {
    const ents = [...SCENE, PT("F", 5.5, 5.5)];
    expect(await compileAndSolve(ents, [C({ type: "coincident", e1: "F", p1: 0, e2: "p", p2: 0 }), ...fixes(FIXED)]))
      .toEqual(near({ entities: [...SCENE, PT("F", 5, 5)], dof: 0, ok: true, conflicts: [], overDefined: [] }));
  });

  it("moves a free line to a fixed point's distance instead of flagging it", async () => {
    const ents = [...SCENE, LN("F", 0, 12, 10, 12)];
    const r = await compileAndSolve(ents, [C({ type: "p2lDistance", e: "p", p: 0, line: "F", value: 3 }), ...fixes(FIXED)]);
    const f = r.entities.at(-1) as Extract<ResolvedEntity, { type: "line" }>;
    const [px, py] = R(5, 5);
    const dist = Math.abs((px - f.x1) * (f.y2 - f.y1) - (py - f.y1) * (f.x2 - f.x1)) / Math.hypot(f.x2 - f.x1, f.y2 - f.y1);
    expect({ ok: r.ok, dof: r.dof, conflicts: r.conflicts, overDefined: r.overDefined, dist }).toEqual({ ok: true, dof: 3, conflicts: [], overDefined: [], dist: expect.closeTo(3, 6) });
  });
});
