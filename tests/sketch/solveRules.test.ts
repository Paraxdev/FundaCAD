// The smaller solve rules: the radius guard and its blame list, rect edge offsets, held axes, merged ends, drags.
import { describe, it, expect, vi } from "vitest";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { coincKey, compileAndSolve, constraintIndexOf, solveKeepingAxes } from "../../src/sketch/sketchSolve";
import { arc, circle, line, near, pl, pt } from "./solveFixtures";

const D = Math.PI / 180;
const on = (cx: number, cy: number, r: number, deg: number) => [cx + r * Math.cos(deg * D), cy + r * Math.sin(deg * D)] as const;
const arcAbout = (id: string, cx: number, cy: number, r: number) => arc(id, ...on(cx, cy, r, 10), ...on(cx, cy, r, 130), ...on(cx, cy, r, 70));
const fix = (e: string, ...ps: number[]) => ps.map((p): SketchConstraint => ({ type: "fix", e, p }));
const rect = (id: string, x: number, y: number, width: number, height: number) => ({ type: "rectangle", id, x, y, width, height }) as ResolvedEntity;

describe("a radius solved through zero is refused, blaming every dimension on that round", () => {
  const c = circle("c", 120, 45, 5), a = arcAbout("a", 140, 60, 5), b = arcAbout("b", 160, 40, 4);
  const l = line("l", 100, 30, 130, 36), q = pt("q", 112, 52), o = circle("o", 120, 45, 9);
  const rows: [string, ResolvedEntity[], SketchConstraint[], string[]][] = [
    ["radius on a circle", [c], [{ type: "radius", e: "c", value: -2 }], ["k0"]],
    ["diameter on a circle", [c], [{ type: "diameter", circle: "c", value: -4 }], ["k0"]],
    ["radius on an arc", [a], [{ type: "radius", e: "a", value: -3 }], ["k0"]],
    ["diameter on an arc", [a], [{ type: "diameter", circle: "a", value: -6 }], ["k0"]],
    ["rim gap", [o, c], [{ type: "radius", e: "c", value: -1 }, { type: "c2cDistance", c1: "o", c2: "c", value: 2 }], ["k0", "k1"]],
    ["line rim gap", [c, l], [{ type: "radius", e: "c", value: -1 }, { type: "c2lDistance", circle: "c", line: "l", value: 3 }], ["k0", "k1"]],
    ["point rim gap", [c, q], [{ type: "radius", e: "c", value: -1 }, { type: "p2cDistance", e: "q", p: 0, circle: "c", value: 2 }], ["k0", "k1"]],
    ["radial gap, only on the round driven negative", [c, o], [{ type: "radius", e: "o", value: 5 }, { type: "radialGap", inner: "c", outer: "o", value: 8 }], ["k1"]],
    ["tangent line", [c, l], [{ type: "radius", e: "c", value: -2 }, { type: "tangent", line: "l", circle: "c" }], ["k0", "k1"]],
    ["tangent line to an arc", [a, l], [{ type: "radius", e: "a", value: -2 }, { type: "tangent2", a: "l", b: "a" }], ["k0", "k1"]],
    ["tangent circles", [o, c], [{ type: "radius", e: "c", value: -2 }, { type: "tangent2", a: "o", b: "c" }], ["k0", "k1"]],
    ["equal circles", [o, c], [{ type: "radius", e: "o", value: -1 }, { type: "equalRadius", a: "c", b: "o" }], ["k0", "k1"]],
    ["tangent circle and arc", [c, a], [{ type: "radius", e: "a", value: -2 }, { type: "tangent2", a: "c", b: "a" }], ["k0", "k1"]],
    ["equal circle and arc", [c, a], [{ type: "radius", e: "a", value: -2 }, { type: "equalRadius", a: "c", b: "a" }], ["k0", "k1"]],
    ["tangent arcs", [a, b], [{ type: "radius", e: "b", value: -2 }, { type: "tangent2", a: "a", b: "b" }], ["k0", "k1"]],
    ["equal arcs", [a, b], [{ type: "radius", e: "b", value: -2 }, { type: "equalRadius", a: "a", b: "b" }], ["k0", "k1"]],
    ["but not a line dimension beside it", [c, l], [{ type: "radius", e: "c", value: -2 }, { type: "horizontal", line: "l" }], ["k0"]],
  ];
  it.each(rows)("%s", async (_n, ents, cons, blamed) => {
    const r = await compileAndSolve(ents, cons);
    expect({ entities: r.entities, ok: r.ok, conflicts: [...r.conflicts].sort() }).toEqual({ entities: ents, ok: false, conflicts: blamed });
  });

  it("lets a small circle grow and refuses a zero diameter", async () => {
    const small = circle("s", 120.5, 45.25, 0.5);
    expect(await compileAndSolve([small], [...fix("s", 0), { type: "radius", e: "s", value: 0.8 }])).toEqual(near({ entities: [circle("s", 120.5, 45.25, 0.8)], dof: 0, ok: true, conflicts: [], overDefined: [] }));
    const zero = await compileAndSolve([small], [...fix("s", 0), { type: "diameter", circle: "s", value: 0 }]);
    expect({ entities: zero.entities, ok: zero.ok, conflicts: zero.conflicts }).toEqual({ entities: [small], ok: false, conflicts: ["k1"] });
  });

  it("still reports a refused drag on a fixed point", async () => {
    const r = await compileAndSolve([c, pt("p", 140, 47)], [{ type: "radius", e: "c", value: -2 }, ...fix("p", 0)], { fromX: 140, fromY: 47, toX: 145, toY: 49 });
    expect({ ok: r.ok, conflicts: r.conflicts, dragRefused: r.dragRefused }).toEqual({ ok: false, conflicts: ["k0"], dragRefused: "fix" });
  });
});

describe("offsets of rectangle edges", () => {
  it("moves only the copy's matching edge for a same index edge pair", async () => {
    const r = await compileAndSolve([rect("r", 105, 55, 10, 10), rect("q", 105, 55, 14, 14)], [...fix("r", 0, 2), { type: "offset", pairs: [{ src: "r~0", cpy: "q~0" }], value: 3 }]);
    // planegcs leaves the free side edges within 1e-3 of where they were
    const q = r.entities[1] as { x: number; y: number; width: number; height: number };
    expect({ ...r, entities: [r.entities[0], { bottom: q.y - q.height / 2, top: q.y + q.height / 2, x: q.x, width: q.width }] }).toEqual({
      entities: [rect("r", 105, 55, 10, 10), { bottom: expect.closeTo(47, 6), top: expect.closeTo(62, 6), x: expect.closeTo(105, 2), width: expect.closeTo(14, 2) }],
      dof: 3, ok: true, conflicts: [], overDefined: [] });
  });

  it("treats a rectangle edge to a line pair like two lines, so the line turns parallel", async () => {
    const r = await compileAndSolve([rect("r", 105, 55, 10, 10), line("b", 95, 46, 105, 47.5)], [...fix("r", 0, 2),
      { type: "hDistance", e1: "r", p1: 0, e2: "b", p2: 0, value: -5 }, { type: "distance", line: "b", value: 10 }, { type: "offset", pairs: [{ src: "r~0", cpy: "b" }], value: 3 }]);
    expect(r).toEqual(near({ entities: [rect("r", 105, 55, 10, 10), line("b", 95, 47, 105, 47)], dof: 0, ok: true, conflicts: [], overDefined: [] }));
  });
});

describe("solveKeepingAxes", () => {
  // an L drawn with a horizontal foot and a vertical leg, the foot re-dimensioned from 10 to 14
  const foot = line("h", 100, 50, 110, 50), leg = line("v", 110, 50, 110, 58);
  const held = near([line("h", 100, 50, 114, 50), line("v", 114, 50, 114, 58)]);

  it("keeps the leg vertical while the foot grows", async () => {
    expect(await solveKeepingAxes([foot, leg], [...fix("h", 0), { type: "distance", line: "h", value: 14 }]))
      .toEqual({ entities: held, dof: 3, ok: true, conflicts: [], overDefined: [] });
  });
  it("keeps the anchor in place when nothing is fixed", async () => {
    expect(await solveKeepingAxes([foot, leg], [{ type: "distance", line: "h", value: 14 }], { x: 100, y: 50 }))
      .toEqual({ entities: held, dof: 5, ok: true, conflicts: [], overDefined: [] });
  });
  it("holds a leg drawn within 1e-6 of vertical", async () => {
    const r = await solveKeepingAxes([foot, line("v", 110, 50, 110 + 5e-7, 58)], [...fix("h", 0), { type: "distance", line: "h", value: 14 }]);
    const v = r.entities[1] as Extract<ResolvedEntity, { type: "line" }>;
    expect([r.ok, v.x2 - v.x1, v.y2]).toEqual([true, expect.closeTo(0, 9), expect.closeTo(58, 9)]);
  });
  it("falls back to the plain solve when held axes would conflict", async () => {
    const cons: SketchConstraint[] = [...fix("h", 0), { type: "angle", l1: "h", l2: "v", value: 80 }];
    expect(await solveKeepingAxes([foot, leg], cons)).toEqual(await compileAndSolve([foot, leg], cons));
  });
});

describe("merged ends", () => {
  const spline = { type: "spline", id: "s", points: [{ x: 100, y: 50 }, { x: 105, y: 56 }, { x: 112, y: 53 }] } as ResolvedEntity;
  const drag = { fromX: 112, fromY: 53, toX: 113, toY: 55.5 };

  it("drags a spline's end with the line end on it, and leaves its inner points alone", async () => {
    const r = await compileAndSolve([spline, line("b", 112, 53, 120, 60), line("c", 105, 56, 98, 62)], [], drag);
    expect(r).toEqual(near({ entities: [{ ...spline, points: [{ x: 100, y: 50 }, { x: 105, y: 56 }, { x: 113, y: 55.5 }] }, line("b", 113, 55.5, 120, 60), line("c", 105, 56, 98, 62)],
      dof: 12, ok: true, conflicts: [], overDefined: [] }));
  });
  // the line comes first next to the closed one, so the drag grabs the line's end and not the unmerged pole under it
  it("drags an open bspline's end pole with the line end on it, but not a closed one's", async () => {
    const poles = [{ x: 112, y: 53 }, { x: 108, y: 60 }, { x: 101, y: 57 }, { x: 99, y: 51 }];
    const open = { type: "bspline", id: "s", poles } as ResolvedEntity, closed = { ...open, closed: true } as ResolvedEntity;
    const ro = await compileAndSolve([open, line("b", 112, 53, 120, 60)], [], drag);
    const rc = await compileAndSolve([line("b", 112, 53, 120, 60), closed], [], drag);
    expect([ro.entities, rc.entities]).toEqual(near([
      [{ ...open, poles: [{ x: 113, y: 55.5 }, ...poles.slice(1)] }, line("b", 113, 55.5, 120, 60)],
      [line("b", 113, 55.5, 120, 60), closed],
    ]));
  });
  it("snaps a spline end coincident onto a line through its last point", async () => {
    const r = await compileAndSolve([spline, line("b", 118, 49, 124, 57)], [...fix("b", 0, 1), { type: "coincident", e1: "s", p1: 1, e2: "b", p2: 0 }]);
    expect(r.entities).toEqual(near([{ ...spline, points: [{ x: 100, y: 50 }, { x: 105, y: 56 }, { x: 118, y: 49 }] }, line("b", 118, 49, 124, 57)]));
  });
  it("merges points into one 0.001 bucket", () => {
    expect([coincKey(100.4996, 50.0004), coincKey(100.5004, 49.9996), coincKey(100.5006, 50)]).toEqual(["100500,50000", "100500,50000", "100501,50000"]);
  });
  it("decodes a user constraint index from a sub id and none from an implicit one", () => {
    expect(["k12p3", "k3", "r~h0", "Rp_rules", "Rp~radius", "x7"].map(constraintIndexOf)).toEqual([12, 3, null, null, null, null]);
  });
});

describe("drags", () => {
  it("grabs the first of two points at the same distance", async () => {
    const r = await compileAndSolve([pt("a", 100, 50), pt("b", 104, 53)], [], { fromX: 102, fromY: 51.5, toX: 101, toY: 49 });
    expect(r).toEqual(near({ entities: [pt("a", 101, 49), pt("b", 104, 53)], dof: 4, ok: true, conflicts: [], overDefined: [] }));
  });
  it("refuses a drag on projected geometry and on a fixed point, naming which", async () => {
    const ents = [pl("P", 100, 50, 110, 56), pt("f", 120, 40)];
    const onProjected = await compileAndSolve(ents, fix("f", 0), { fromX: 110, fromY: 56.1, toX: 112, toY: 59 });
    const onFixed = await compileAndSolve(ents, fix("f", 0), { fromX: 120.1, fromY: 40, toX: 125, toY: 42 });
    expect([onProjected, onFixed]).toEqual([
      { entities: ents, dof: 0, ok: true, conflicts: [], overDefined: [], dragRefused: "projected" },
      { entities: ents, dof: 0, ok: true, conflicts: [], overDefined: [], dragRefused: "fix" },
    ]);
  });
});
