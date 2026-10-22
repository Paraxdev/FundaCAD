// Arc read-back and the rim side guards on turned geometry away from the origin, against the real planegcs.
import { describe, it, expect, vi } from "vitest";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve } from "../../src/sketch/sketchSolve";
import { arc, circle, line, near, pc, pl, pt } from "./solveFixtures";

const D = Math.PI / 180;
const on = (cx: number, cy: number, r: number, deg: number) => [cx + r * Math.cos(deg * D), cy + r * Math.sin(deg * D)] as const;
const fix = (e: string, ...ps: number[]) => ps.map((p): SketchConstraint => ({ type: "fix", e, p }));
const refused = (ents: ResolvedEntity[], conflicts: string[], overDefined: string[] = []) => ({ entities: ents, ok: false, conflicts, overDefined });
const outcome = (r: { entities: ResolvedEntity[]; ok: boolean; conflicts: string[]; overDefined: string[] }) =>
  ({ entities: r.entities, ok: r.ok, conflicts: [...r.conflicts].sort(), overDefined: r.overDefined });

describe("an arc reads back its mid-sweep as the through point", () => {
  it("keeps a 270 degree arc drawn clockwise on its long side", async () => {
    // from 0 to 90 degrees about (130,70), through 135 degrees: the long way round, so its sweep runs 90 to 360
    const a = arc("a", ...on(130, 70, 5, 0), ...on(130, 70, 5, 90), ...on(130, 70, 5, 135));
    const r = await compileAndSolve([a], []);
    expect(r).toEqual(near({ entities: [arc("a", ...on(130, 70, 5, 0), ...on(130, 70, 5, 90), ...on(130, 70, 5, 225))], dof: 5, ok: true, conflicts: [], overDefined: [] }));
  });

  it("keeps a short arc drawn counterclockwise", async () => {
    const a = arc("a", ...on(130, 70, 5, 20), ...on(130, 70, 5, 110), ...on(130, 70, 5, 40));
    const r = await compileAndSolve([a], []);
    expect(r).toEqual(near({ entities: [arc("a", ...on(130, 70, 5, 20), ...on(130, 70, 5, 110), ...on(130, 70, 5, 65))], dof: 5, ok: true, conflicts: [], overDefined: [] }));
  });

  it("keeps a short counterclockwise arc below the x axis", async () => {
    const a = arc("a", ...on(130, -70, 5, 20), ...on(130, -70, 5, 110), ...on(130, -70, 5, 40));
    const r = await compileAndSolve([a], []);
    expect(r).toEqual(near({ entities: [arc("a", ...on(130, -70, 5, 20), ...on(130, -70, 5, 110), ...on(130, -70, 5, 65))], dof: 5, ok: true, conflicts: [], overDefined: [] }));
  });

  it("reads back a solved arc drawn end first from its moved ends", async () => {
    // ends held on two turned lines through the fixed centre, radius 5 grown to 7
    const g1 = pl("g1", 130, 70, ...on(130, 70, 20, 30)), g2 = pl("g2", 130, 70, ...on(130, 70, 20, 150));
    const a = arc("a", ...on(130, 70, 5, 150), ...on(130, 70, 5, 30), ...on(130, 70, 5, 90));
    const cons: SketchConstraint[] = [...fix("a", 2), { type: "pointOnCurve", e: "a", p: 0, curve: "g2" }, { type: "pointOnCurve", e: "a", p: 1, curve: "g1" }, { type: "radius", e: "a", value: 7 }];
    const r = await compileAndSolve([g1, g2, a], cons);
    expect(r).toEqual(near({ entities: [g1, g2, arc("a", ...on(130, 70, 7, 150), ...on(130, 70, 7, 30), ...on(130, 70, 7, 90))], dof: 0, ok: true, conflicts: [], overDefined: [] }));
  });

  // b's start sits on the centre and must still be free to move, to (130,77)
  const b = line("b", 130, 70, 130, 82);
  const shorten: SketchConstraint[] = [...fix("b", 1), { type: "vertical", line: "b" }, { type: "distance", line: "b", value: 5 }];
  it("keeps an arc's centre apart from a line end drawn on it", async () => {
    const a = arc("a", ...on(130, 70, 5, 20), ...on(130, 70, 5, 110), ...on(130, 70, 5, 40));
    const r = await compileAndSolve([a, b], [...fix("a", 0, 1, 2), ...shorten]);
    expect(r).toEqual(near({ entities: [arc("a", ...on(130, 70, 5, 20), ...on(130, 70, 5, 110), ...on(130, 70, 5, 65)), line("b", 130, 77, 130, 82)], dof: 0, ok: true, conflicts: [], overDefined: [] }));
  });
  it("keeps a circle's centre, user or projected, apart from a line end drawn on it", async () => {
    const r = await compileAndSolve([circle("c", 130, 70, 4), b], [...fix("c", 0), { type: "radius", e: "c", value: 4 }, ...shorten]);
    const rp = await compileAndSolve([pc("c", 130, 70, 4), b], shorten);
    expect([r, rp]).toEqual(near([
      { entities: [circle("c", 130, 70, 4), line("b", 130, 77, 130, 82)], dof: 0, ok: true, conflicts: [], overDefined: [] },
      { entities: [pc("c", 130, 70, 4), line("b", 130, 77, 130, 82)], dof: 0, ok: true, conflicts: [], overDefined: [] },
    ]));
  });
});

describe("a rim dimension may not be satisfied by flipping its configuration", () => {
  // u = (0.8,0.6) along, n = (-0.6,0.8) across, about (100,50)
  const at = (s: number, t: number) => [100 + 0.8 * s - 0.6 * t, 50 + 0.6 * s + 0.8 * t] as const;

  it("refuses a point rim gap met from inside the rim, accepts it from outside", async () => {
    const ents = [circle("c", 100, 50, 5), pt("p", ...at(10, 0))];
    // pinned by the radius, planegcs also finds the gap redundant
    const gap: SketchConstraint = { type: "p2cDistance", e: "p", p: 0, circle: "c", value: 2 };
    expect(outcome(await compileAndSolve(ents, [...fix("c", 0), ...fix("p", 0), { type: "radius", e: "c", value: 12 }, gap]))).toEqual(refused(ents, ["k3"], ["k3"]));
    expect(outcome(await compileAndSolve(ents, [...fix("c", 0), ...fix("p", 0), gap]))).toEqual(near({ entities: [circle("c", 100, 50, 8), ents[1]], ok: true, conflicts: [], overDefined: [] }));
  });

  it("refuses a line rim gap met across the rim, accepts it clear of the line", async () => {
    const l = line("l", ...at(-10, 0), ...at(10, 0));
    const ents = [circle("c", ...at(0, 10), 5), l];
    const gap: SketchConstraint = { type: "c2lDistance", circle: "c", line: "l", value: 3 };
    expect(outcome(await compileAndSolve(ents, [...fix("c", 0), ...fix("l", 0, 1), { type: "radius", e: "c", value: 13 }, gap]))).toEqual(refused(ents, ["k3", "k4"]));
    expect(outcome(await compileAndSolve(ents, [...fix("c", 0), ...fix("l", 0, 1), gap]))).toEqual(near({ entities: [circle("c", ...at(0, 10), 7), l], ok: true, conflicts: [], overDefined: [] }));
  });

  it("refuses a circle hopping to the other side of the line", async () => {
    const ents = [circle("c", ...at(0, 10), 5), line("l", ...at(-10, 0), ...at(10, 0)), pt("anchor", ...at(0, -8))];
    const cons: SketchConstraint[] = [...fix("l", 0, 1), ...fix("anchor", 0), { type: "radius", e: "c", value: 5 }, { type: "c2lDistance", circle: "c", line: "l", value: 3 },
      { type: "coincident", e1: "c", p1: 0, e2: "anchor", p2: 0 }];
    expect(outcome(await compileAndSolve(ents, cons))).toEqual(refused(ents, ["k4"], ["k4"]));
  });

  it("refuses a rim gap met by nesting, but not a driven one", async () => {
    const ents = [circle("a", 100, 50, 5), circle("b", ...at(20, 0), 3)];
    const gap = (driven: boolean): SketchConstraint => ({ type: "c2cDistance", c1: "a", c2: "b", value: 2, ...(driven ? { driven: true } : {}) });
    const cons = (driven: boolean): SketchConstraint[] => [gap(driven), { type: "concentric", c1: "a", c2: "b" }, ...fix("a", 0)];
    expect(outcome(await compileAndSolve(ents, cons(false)))).toEqual(refused(ents, ["k0"]));
    expect(await compileAndSolve(ents, cons(true))).toEqual(near({ entities: [ents[0], circle("b", 100, 50, 3)], dof: 2, ok: true, conflicts: [], overDefined: [] }));
  });

  // the coincident on q already holds t's start at the offset, so planegcs finds its distance redundant
  it("refuses a line offset met on the far side, accepts one that slides along its own side", async () => {
    const s = line("s", ...at(0, 0), ...at(10, 0)), t = line("t", ...at(0, 3), ...at(10, 3));
    const solve = (q: readonly [number, number]) => compileAndSolve([s, t, pt("q", ...q)],
      [...fix("s", 0, 1), ...fix("q", 0), { type: "offset", pairs: [{ src: "s", cpy: "t" }], value: 3 }, { type: "coincident", e1: "t", p1: 0, e2: "q", p2: 0 }]);
    expect(outcome(await solve(at(0, -3)))).toEqual(refused([s, t, pt("q", ...at(0, -3))], ["k3"], ["k3a0"]));
    expect(await solve(at(2, 3))).toEqual(near({ entities: [s, line("t", ...at(2, 3), ...at(10, 3)), pt("q", ...at(2, 3))], dof: 1, ok: true, conflicts: [], overDefined: ["k3a0"] }));
  });
});
