// Solver-fixed integration for projected reference geometry (plan step 5),
// exercised against the REAL planegcs WASM: projected curves compile as pinned
// primitives, user constraints/dims attach to them, and user geometry follows
// when the projection moves (the associative payoff). The wasm `?url` import
// resolves root-relative under vitest, so locateFile needs the absolute path.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve, constraintIndexOf } from "../../src/sketch/sketchSolve";
import { breakLink } from "../../src/sketch/modify";
import { rectCorners } from "../../src/sketch/region";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { ProjectedCurve, SketchConstraint } from "../../src/types";

const SRC = { kind: "sketchCurve", sketch: "s0", entity: "e0" } as const;
const projected = (id: string, curve: ProjectedCurve): ResolvedEntity => ({ type: "projected", id, source: SRC, curve });
const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({ type: "line", id, x1, y1, x2, y2 });

/** the projected entities of a pass, for asserting they never move */
const projectedOf = (ents: ResolvedEntity[]) => ents.filter((e) => e.type === "projected");

describe("constraintIndexOf implicit-id contract", () => {
  it("decodes user ids and rejects `~` internal ids", () => {
    expect(constraintIndexOf("k7")).toBe(7);
    expect(constraintIndexOf("k7a")).toBe(7); // composite suffix
    expect(constraintIndexOf("e3~r")).toBeNull(); // projected radius pin
    expect(constraintIndexOf("e3~h0")).toBeNull(); // rectangle rule
    expect(constraintIndexOf("__dragc")).toBeNull();
  });
});

describe("projected geometry compiles as fixed solver primitives", () => {
  it("projected-only sketch has 0 DOF; a free user line keeps its 4", async () => {
    const ents = [projected("pl", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 }), line("u", 5, 5, 15, 5)];
    const r = await compileAndSolve(ents, [{ type: "horizontal", line: "u" }]);
    expect(r.ok).toBe(true);
    // projected removes no user DOF: horizontal takes 1 of the line's 4
    expect(r.dof).toBe(3);
  });

  it("user line coincident to a projected endpoint follows when the projection moves", async () => {
    const constraints: SketchConstraint[] = [
      { type: "coincident", e1: "u", p1: 0, e2: "pl", p2: 1 },
      { type: "horizontal", line: "u" },
      { type: "distance", line: "u", value: 20 },
    ];
    const before = [projected("pl", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 }), line("u", 40, 0, 60, 2)];
    const r1 = await compileAndSolve(before, constraints);
    expect(r1.ok).toBe(true);
    expect(r1.conflicts).toEqual([]);
    const u1 = r1.entities.find((e) => e.id === "u");
    expect(u1).toMatchObject({ x1: 40, y1: 0 });
    if (u1?.type !== "line") throw new Error("line lost");
    expect(Math.hypot(u1.x2 - u1.x1, u1.y2 - u1.y1)).toBeCloseTo(20, 6);

    // simulate a projection refresh: the source moved up by 5
    const moved = [projected("pl", { kind: "line", x1: 0, y1: 5, x2: 40, y2: 5 }), u1];
    const r2 = await compileAndSolve(moved, constraints);
    expect(r2.ok).toBe(true);
    const u2 = r2.entities.find((e) => e.id === "u");
    if (u2?.type !== "line") throw new Error("line lost");
    expect(u2.x1).toBeCloseTo(40, 6);
    expect(u2.y1).toBeCloseTo(5, 6); // followed the projection
    expect(u2.y2).toBeCloseTo(5, 6); // horizontal held
    expect(Math.hypot(u2.x2 - u2.x1, u2.y2 - u2.y1)).toBeCloseTo(20, 6);
    // the projected entity itself is byte-identical
    expect(projectedOf(r2.entities)).toEqual(projectedOf(moved));
  });

  it("projected coords never change, even under a conflicting dim", async () => {
    const ents = [projected("pl", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 })];
    // driving dim between the two fixed endpoints with the WRONG value
    const r = await compileAndSolve(ents, [{ type: "p2pDistance", e1: "pl", p1: 0, e2: "pl", p2: 1, value: 30 }]);
    expect(projectedOf(r.entities)).toEqual(ents); // untouched
    // the impossible dim surfaces (conflict or redundancy, never silence)
    const flagged = [...r.conflicts, ...r.overDefined].map(constraintIndexOf).filter((i) => i !== null);
    expect(flagged).toContain(0);
  });

  it("a driving dim between two fully-fixed projected points is over-defined, not a crash", async () => {
    const ents = [
      projected("pa", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 }),
      projected("pb", { kind: "line", x1: 0, y1: 10, x2: 40, y2: 10 }),
    ];
    // value matches the true distance → satisfiable but adds nothing
    const r = await compileAndSolve(ents, [{ type: "p2pDistance", e1: "pa", p1: 0, e2: "pb", p2: 0, value: 10 }]);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.overDefined.map(constraintIndexOf)).toContain(0); // amber via existing plumbing
    expect(projectedOf(r.entities)).toEqual(ents);
  });

  it("projected circle: center + radius pinned; a dimensioned user line moves instead", async () => {
    const ents = [
      projected("pc", { kind: "circle", x: 10, y: 10, r: 5 }),
      line("u", 30, 10, 45, 10),
    ];
    const constraints: SketchConstraint[] = [
      { type: "horizontal", line: "u" },
      { type: "distance", line: "u", value: 15 },
      // p2p dim from the user line start to the projected circle CENTER (p 0)
      { type: "p2pDistance", e1: "u", p1: 0, e2: "pc", p2: 0, value: 12 },
    ];
    const r = await compileAndSolve(ents, constraints);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    // no internal `~r` pin ever surfaces as a user constraint problem
    expect([...r.conflicts, ...r.overDefined].map(constraintIndexOf).filter((i) => i !== null)).toEqual([]);
    expect(projectedOf(r.entities)).toEqual([ents[0]]); // circle untouched
    const u = r.entities.find((e) => e.id === "u");
    if (u?.type !== "line") throw new Error("line lost");
    expect(Math.hypot(u.x1 - 10, u.y1 - 10)).toBeCloseTo(12, 5); // line obeyed the dim
  });

  it("projected arc: all three points fixed; coincident user geometry follows a refresh", async () => {
    // semicircle: (0,0)→(10,0) through (5,5), center (5,0) r=5
    const arc: ProjectedCurve = { kind: "arc", x1: 0, y1: 0, x2: 10, y2: 0, mx: 5, my: 5 };
    const constraints: SketchConstraint[] = [
      { type: "coincident", e1: "u", p1: 0, e2: "pa", p2: 1 },
      { type: "vertical", line: "u" },
      { type: "distance", line: "u", value: 8 },
    ];
    const before = [projected("pa", arc), line("u", 10, 0, 10, -8)];
    const r1 = await compileAndSolve(before, constraints);
    expect(r1.ok).toBe(true);
    expect(projectedOf(r1.entities)).toEqual([before[0]]);
    // refresh: arc slides +3 in x
    const movedArc: ProjectedCurve = { kind: "arc", x1: 3, y1: 0, x2: 13, y2: 0, mx: 8, my: 5 };
    const u1 = r1.entities.find((e) => e.id === "u");
    if (u1?.type !== "line") throw new Error("line lost");
    const r2 = await compileAndSolve([projected("pa", movedArc), u1], constraints);
    expect(r2.ok).toBe(true);
    const u2 = r2.entities.find((e) => e.id === "u");
    if (u2?.type !== "line") throw new Error("line lost");
    expect(u2.x1).toBeCloseTo(13, 6); // stuck to the arc's moved endpoint
    expect(u2.y1).toBeCloseTo(0, 6);
    expect(Math.abs(u2.y2 - u2.y1)).toBeCloseTo(8, 6);
  });

  it("projected poly: first/last samples anchor coincident geometry", async () => {
    const poly: ProjectedCurve = { kind: "poly", pts: [[0, 0], [2, 1], [4, 1.5], [6, 1]] };
    const constraints: SketchConstraint[] = [
      { type: "coincident", e1: "u", p1: 0, e2: "pp", p2: 1 },
      { type: "horizontal", line: "u" },
      { type: "distance", line: "u", value: 5 },
    ];
    const ents = [projected("pp", poly), line("u", 6, 1, 11, 2)];
    const r = await compileAndSolve(ents, constraints);
    expect(r.ok).toBe(true);
    const u = r.entities.find((e) => e.id === "u");
    if (u?.type !== "line") throw new Error("line lost");
    expect(u.x1).toBeCloseTo(6, 6);
    expect(u.y1).toBeCloseTo(1, 6); // anchored on the last sample
    expect(u.y2).toBeCloseTo(1, 6);
    expect(projectedOf(r.entities)).toEqual([ents[0]]);
  });

  it("coincident on an exactly-snapped projected endpoint: merged, no conflict", async () => {
    // user line starts EXACTLY on the projected endpoint → position-merge into
    // one (fixed) solver point. planegcs flags the now-vacuous coincident as
    // removable (same as native snapped+coincident endpoints, pre-existing,
    // uniform behavior); it must never read as a CONFLICT, and the merge is
    // what anchors the line to the reference.
    const ents = [projected("pl", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 }), line("u", 40, 0, 55, 5)];
    const r = await compileAndSolve(ents, [{ type: "coincident", e1: "u", p1: 0, e2: "pl", p2: 1 }]);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.overDefined.map(constraintIndexOf)).toContain(0); // removable, amber like native
  });

  it("dragging a user endpoint merged onto a projected point is refused (no fighting)", async () => {
    // user line starts EXACTLY on the projected endpoint → positions merge, point is fixed
    const ents = [projected("pl", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 }), line("u", 40, 0, 60, 0)];
    const constraints: SketchConstraint[] = [{ type: "distance", line: "u", value: 20 }];
    const r = await compileAndSolve(ents, constraints, { fromX: 40, fromY: 0, toX: 45, toY: 9 });
    expect(r.conflicts).toEqual([]); // refused cleanly, not reported as inconsistent
    expect(r.dragRefused).toBe("projected"); // reported: caller keeps its anchor + explains
    const u = r.entities.find((e) => e.id === "u");
    expect(u).toMatchObject({ x1: 40, y1: 0 }); // did not move
    expect(projectedOf(r.entities)).toEqual([ents[0]]);
  });

  it("dragRefused distinguishes a user `fix` pin, and a free drag reports nothing", async () => {
    const ents = [line("u", 0, 0, 20, 0)];
    const fixed = await compileAndSolve(ents, [{ type: "fix", e: "u", p: 0 }], { fromX: 0, fromY: 0, toX: 5, toY: 5 });
    expect(fixed.dragRefused).toBe("fix");
    expect(fixed.entities.find((e) => e.id === "u")).toMatchObject({ x1: 0, y1: 0 });
    const free = await compileAndSolve(ents, [], { fromX: 20, fromY: 0, toX: 25, toY: 5 });
    expect(free.dragRefused).toBeUndefined();
    expect(free.entities.find((e) => e.id === "u")).toMatchObject({ x2: 25, y2: 5 });
  });
});

describe("Break Link, constraints survive the projected→native conversion", () => {
  it("a dim + coincident to a broken (now native) line still resolve, and the line drags", async () => {
    const constraints: SketchConstraint[] = [
      { type: "coincident", e1: "u", p1: 0, e2: "pl", p2: 1 },
      { type: "p2pDistance", e1: "u", p1: 1, e2: "pl", p2: 0, value: 50 },
    ];
    const before = [projected("pl", { kind: "line", x1: 0, y1: 0, x2: 40, y2: 0 }), line("u", 40, 0, 55, 5)];
    const r1 = await compileAndSolve(before, constraints);
    expect(r1.ok).toBe(true);
    expect(r1.conflicts).toEqual([]);

    // Break Link: same id, native line, the constraints keep their targets
    const broken = breakLink(r1.entities, new Set(["pl"]));
    expect(broken[0]).toMatchObject({ type: "line", id: "pl" });
    const r2 = await compileAndSolve(broken, constraints);
    expect(r2.ok).toBe(true);
    expect(r2.conflicts).toEqual([]);
    // fixed→free: the ex-projected line's 4 DOF joined the sketch (never over-constrains)
    expect(r2.dof).toBeGreaterThan(r1.dof);

    // dragging the ex-projected endpoint now WORKS (it was refused while linked)
    const r3 = await compileAndSolve(broken, constraints, { fromX: 0, fromY: 0, toX: -5, toY: 3 });
    expect(r3.dragRefused).toBeUndefined();
    const dragged = r3.entities.find((e) => e.id === "pl");
    if (dragged?.type !== "line") throw new Error("line lost");
    expect(dragged.x1).toBeCloseTo(-5, 6);
    expect(dragged.y1).toBeCloseTo(3, 6);
  });

  it("a p2p dim to a broken closed poly (now C0-closed spline) still resolves at index 0", async () => {
    const closed: ProjectedCurve = { kind: "poly", pts: [[0, 0], [4, 4], [8, 0], [0, 0]] };
    const constraints: SketchConstraint[] = [
      { type: "p2pDistance", e1: "u", p1: 0, e2: "pq", p2: 0, value: 10 },
    ];
    const ents = [projected("pq", closed), line("u", 10, 0, 20, 0)];
    const r1 = await compileAndSolve(ents, constraints);
    expect(r1.ok).toBe(true);
    expect(r1.conflicts).toEqual([]);

    const broken = breakLink(ents, new Set(["pq"]));
    expect(broken[0]).toMatchObject({ type: "spline", id: "pq" });
    const r2 = await compileAndSolve(broken, constraints);
    expect(r2.ok).toBe(true);
    expect(r2.conflicts).toEqual([]);
    const u = r2.entities.find((e) => e.id === "u");
    if (u?.type !== "line") throw new Error("line lost");
    // the dim held against the spline's endpoint 0 (same location the closed
    // poly exposed as its one addressable point)
    const sp = r2.entities.find((e) => e.id === "pq");
    if (sp?.type !== "spline") throw new Error("spline lost");
    const p0 = sp.points[0]!;
    expect(Math.hypot(u.x1 - p0.x, u.y1 - p0.y)).toBeCloseTo(10, 5);
  });
});

// The associative payoff for Offset, against the REAL solver. The bug this
// fixes: an offset copy carried no constraint at all, so it drifted off its
// source on the next solve ("de-concentrified") and its distance wasn't editable.
describe("offset constraint, the copy stays tied to its source", () => {
  const circle = (id: string, x: number, y: number, r: number): ResolvedEntity =>
    ({ type: "circle", id, x, y, radius: r });

  it("pulls a drifted copy back to concentric at the right gap (the ring case)", async () => {
    // the copy starts off-centre and at the wrong radius, as if it had drifted
    const ents = [circle("c1", 0, 0, 5), circle("c2", 0.7, -0.4, 7.1)];
    const cons: SketchConstraint[] = [
      { type: "offset", pairs: [{ src: "c1", cpy: "c2" }], value: 3 },
    ];
    const r = await compileAndSolve(ents, cons);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const a = r.entities.find((e) => e.id === "c1");
    const b = r.entities.find((e) => e.id === "c2");
    if (a?.type !== "circle" || b?.type !== "circle") throw new Error("circles lost");
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(0, 5); // concentric again
    expect(b.radius - a.radius).toBeCloseTo(3, 5); // and the gap is the dim
  });

  it("makes the copy FOLLOW an upstream radius change", async () => {
    const ents = [circle("c1", 0, 0, 5), circle("c2", 0, 0, 8)];
    const cons: SketchConstraint[] = [
      { type: "offset", pairs: [{ src: "c1", cpy: "c2" }], value: 3 },
      { type: "radius", e: "c1", value: 9 }, // drive the SOURCE bigger
    ];
    const r = await compileAndSolve(ents, cons);
    expect(r.ok).toBe(true);
    const a = r.entities.find((e) => e.id === "c1");
    const b = r.entities.find((e) => e.id === "c2");
    if (a?.type !== "circle" || b?.type !== "circle") throw new Error("circles lost");
    expect(a.radius).toBeCloseTo(9, 5);
    expect(b.radius).toBeCloseTo(12, 5); // followed, keeping the 3mm wall
  });

  it("takes a NEGATIVE value as an inward offset (signed, no branch ambiguity)", async () => {
    const ents = [circle("c1", 0, 0, 5), circle("c2", 0, 0, 3)];
    const cons: SketchConstraint[] = [
      { type: "offset", pairs: [{ src: "c1", cpy: "c2" }], value: -2 },
      { type: "radius", e: "c1", value: 10 },
    ];
    const r = await compileAndSolve(ents, cons);
    expect(r.ok).toBe(true);
    const b = r.entities.find((e) => e.id === "c2");
    if (b?.type !== "circle") throw new Error("circle lost");
    expect(b.radius).toBeCloseTo(8, 5); // stayed INSIDE
  });

  it("governs a whole 4-line chain from ONE value (Fusion: not four dims)", async () => {
    // a 10x10 square and its inward copy at 2mm, corners joined
    const sq = (p: string, o: number): ResolvedEntity[] => [
      line(`${p}0`, o, o, 10 - o, o),
      line(`${p}1`, 10 - o, o, 10 - o, 10 - o),
      line(`${p}2`, 10 - o, 10 - o, o, 10 - o),
      line(`${p}3`, o, 10 - o, o, o),
    ];
    // the copy starts SLOPPY, 1.4mm on one side, 2.6 on another
    const ents = [...sq("s", 0), ...sq("c", 0), ...[]];
    const copy = [
      line("c0", 1.4, 1.4, 8.7, 1.4), line("c1", 8.7, 1.4, 8.7, 8.6),
      line("c2", 8.7, 8.6, 1.3, 8.6), line("c3", 1.3, 8.6, 1.4, 1.4),
    ];
    const all = [...ents.slice(0, 4), ...copy];
    const cons: SketchConstraint[] = [
      // the copy's corners are a chain
      { type: "coincident", e1: "c0", p1: 1, e2: "c1", p2: 0 },
      { type: "coincident", e1: "c1", p1: 1, e2: "c2", p2: 0 },
      { type: "coincident", e1: "c2", p1: 1, e2: "c3", p2: 0 },
      { type: "coincident", e1: "c3", p1: 1, e2: "c0", p2: 0 },
      // ...and ONE offset dim governs every member
      { type: "offset", value: 2, pairs: [0, 1, 2, 3].map((k) => ({ src: `s${k}`, cpy: `c${k}` })) },
    ];
    const r = await compileAndSolve(all, cons);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    // every copy edge ends up exactly 2mm from its source edge
    for (const k of [0, 1, 2, 3]) {
      const s = r.entities.find((e) => e.id === `s${k}`);
      const c = r.entities.find((e) => e.id === `c${k}`);
      if (s?.type !== "line" || c?.type !== "line") throw new Error("chain lost");
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const len = Math.hypot(dx, dy) || 1;
      const perp = Math.abs((c.x1 - s.x1) * dy - (c.y1 - s.y1) * dx) / len;
      expect(perp).toBeCloseTo(2, 4);
      // and parallel to it
      expect(Math.abs((c.x2 - c.x1) * dy - (c.y2 - c.y1) * dx) / (len * len)).toBeCloseTo(0, 4);
    }
  });

  it("survives losing one copy: the pair list shrinks, the rest stay linked", async () => {
    // pruneConstraints drops the dead pair; the solver must accept what's left
    const ents = [circle("c1", 0, 0, 5), circle("c2", 0, 0, 8)];
    const cons: SketchConstraint[] = [
      { type: "offset", value: 3, pairs: [{ src: "c1", cpy: "c2" }, { src: "gone", cpy: "alsogone" }] },
    ];
    const r = await compileAndSolve(ents, cons);
    expect(r.ok).toBe(true);
    const b = r.entities.find((e) => e.id === "c2");
    if (b?.type !== "circle") throw new Error("circle lost");
    expect(b.radius).toBeCloseTo(8, 5); // the live pair still holds
  });
});

describe("a rotated rectangle survives the solver", () => {
  // The failure this exists for is silent and total. A rectangle used to be
  // pinned to the sketch axes with four horizontal/vertical rules; those do not
  // FAIL on a rectangle drawn at an angle, they succeed, quietly straightening
  // it on the first solve after it was placed. And the read-back took the
  // axis-aligned bounding box of the solved corners, which for a 10x4 turned
  // 37.5 degrees is 10.4 x 9.3, so the shape inflated too.
  const rect = (angle?: number): ResolvedEntity =>
    ({ type: "rectangle", id: "r1", x: -7, y: 2, width: 10, height: 4, ...(angle ? { angle } : {}) }) as ResolvedEntity;

  const solved = async (e: ResolvedEntity, cs: SketchConstraint[] = []) => {
    const r = await compileAndSolve([e], cs);
    return r.entities[0] as { x: number; y: number; width: number; height: number; angle?: number };
  };

  it("keeps its angle, size and place with nothing else constraining it", async () => {
    const out = await solved(rect(37.5));
    expect(out.angle).toBeCloseTo(37.5, 6);
    expect(out.width).toBeCloseTo(10, 6);
    expect(out.height).toBeCloseTo(4, 6);
    expect(out.x).toBeCloseTo(-7, 6);
    expect(out.y).toBeCloseTo(2, 6);
  });

  it("survives repeated solves rather than creeping", async () => {
    // Every edit re-solves, so a small error per pass is a rectangle that walks.
    let e = rect(37.5);
    for (let i = 0; i < 5; i++) e = (await compileAndSolve([e], [])).entities[0]!;
    const out = e as { width: number; height: number; angle?: number };
    expect(out.angle).toBeCloseTo(37.5, 6);
    expect(out.width).toBeCloseTo(10, 6);
    expect(out.height).toBeCloseTo(4, 6);
  });

  it("is RIGID: another entity's constraints cannot deform or spin it", async () => {
    // The alternative that was tried and rejected: hold the shape with
    // parallel/perpendicular rules instead of the axis rules. That keeps the
    // rectangle a rectangle but leaves its ANGLE free, and a free angle is one
    // the solver moves. Measured, dimensioning both edges spun a 37.5-degree
    // rectangle to 33.8. So the corners are pinned instead, as a polygon's are.
    const other = line("u", 0, 0, 10, 0);
    const r = await compileAndSolve([rect(37.5), other], [
      { type: "distance", id: "k0", line: "u", value: 25 },
      { type: "vertical", line: "u" },
    ]);
    const out = r.entities[0] as { width: number; height: number; angle?: number };
    expect(out.angle).toBeCloseTo(37.5, 9);
    expect(out.width).toBeCloseTo(10, 9);
    expect(out.height).toBeCloseTo(4, 9);
  });

  it("leaves an axis-aligned rectangle on exactly the path it was on", async () => {
    const out = await solved(rect());
    expect(out).toEqual({ type: "rectangle", id: "r1", x: -7, y: 2, width: 10, height: 4 });
    expect("angle" in out).toBe(false); // no angle field written into a plain rectangle
  });

  it("still lets the axis rules straighten a rectangle that has no angle", async () => {
    // The other half of the branch: without an angle the four horizontal/
    // vertical rules are still what holds it, so a rectangle whose corners were
    // nudged off-axis is pulled back square to the sketch.
    const out = await solved(rect(), [{ type: "distance", id: "k0", line: "r1~1", value: 9 }]);
    expect(out.height).toBeCloseTo(9, 4);
    expect(out.width).toBeCloseTo(10, 4);
  });
});

describe("SK-3: coincident reaches a circle centre and a rectangle corner", () => {
  // endpointPoint (coincident/symmetric/midpoint's point resolver) used to
  // only know lines/arcs/points/splines/bsplines: a circle centre or a
  // rectangle corner operand resolved to undefined, so the constraint was
  // silently dropped from the compiled solver input, added to the document
  // but never actually pulling anything. dimPoint (p2pDistance/fix) already
  // handled both; this mirrors that.
  const circ = (id: string, x: number, y: number, r: number): ResolvedEntity => ({ type: "circle", id, x, y, radius: r });
  const rect = (id: string, x: number, y: number, width: number, height: number): ResolvedEntity =>
    ({ type: "rectangle", id, x, y, width, height }) as ResolvedEntity;
  const arc = (id: string, x1: number, y1: number, x2: number, y2: number, mx: number, my: number): ResolvedEntity =>
    ({ type: "arc", id, x1, y1, x2, y2, mx, my }) as ResolvedEntity;

  it("pulls a circle's centre onto a rectangle corner", async () => {
    const r1 = rect("r1", 0, 0, 20, 10);
    const c1 = circ("c1", 50, 50, 5);
    const corner3 = rectCorners(0, 0, 20, 10)[3]!; // pin the rect rigid (2 opposite corners) so the only freedom left is the circle's centre
    const cons: SketchConstraint[] = [
      { type: "fix", e: "r1", p: 1 },
      { type: "fix", e: "r1", p: 3 },
      { type: "diameter", circle: "c1", value: 10 },
      { type: "coincident", e1: "c1", p1: 0, e2: "r1", p2: 3 },
    ];
    const r = await compileAndSolve([r1, c1], cons);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.dof).toBe(0);
    const outCirc = r.entities.find((e) => e.id === "c1") as { x: number; y: number };
    expect(outCirc.x).toBeCloseTo(corner3.x, 6);
    expect(outCirc.y).toBeCloseTo(corner3.y, 6);
  });

  it("pulls two circles' centres together (plain circle-centre coincident, not concentric)", async () => {
    const c1 = circ("c1", 0, 0, 5);
    const c2 = circ("c2", 30, 30, 3);
    const cons: SketchConstraint[] = [{ type: "coincident", e1: "c1", p1: 0, e2: "c2", p2: 0 }];
    const r = await compileAndSolve([c1, c2], cons);
    expect(r.ok).toBe(true);
    const a = r.entities.find((e) => e.id === "c1") as { x: number; y: number };
    const b = r.entities.find((e) => e.id === "c2") as { x: number; y: number };
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
  });

  it("pulls a point onto an arc's centre (index 2, not the arc's end)", async () => {
    const a1 = arc("a1", 10, 0, 0, 10, 7.071, 7.071); // quarter circle, centre (0,0), r=10
    const p1: ResolvedEntity = { type: "point", id: "p1", x: 40, y: 40 };
    // pin the arc's centre itself, so the only freedom left is the point
    const cons: SketchConstraint[] = [
      { type: "fix", e: "a1", p: 2 },
      { type: "coincident", e1: "p1", p1: 0, e2: "a1", p2: 2 },
    ];
    const r = await compileAndSolve([a1, p1], cons);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const outPt = r.entities.find((e) => e.id === "p1") as { x: number; y: number };
    expect(outPt.x).toBeCloseTo(0, 3);
    expect(outPt.y).toBeCloseTo(0, 3);
  });
});

describe("SK-6: a corner pinned to the Origin stays put under an unrelated dim", () => {
  // sketchMode's own pointerdown handler creates exactly this: a fixed
  // construction point at (0,0), which merges (by position, coincKey) with
  // whatever entity corner was drawn on top of it. This test is the solver's
  // half of the fix: once merged, that corner is genuinely un-movable, so a
  // LATER dimension that only concerns some other, free entity has nowhere
  // else to land its DOF but that other entity.
  const rect = (id: string, x: number, y: number, width: number, height: number): ResolvedEntity =>
    ({ type: "rectangle", id, x, y, width, height }) as ResolvedEntity;
  const circ = (id: string, x: number, y: number, r: number): ResolvedEntity => ({ type: "circle", id, x, y, radius: r });
  const originPt: ResolvedEntity = { type: "point", id: "o", x: 0, y: 0, construction: true };

  it("moves the circle, not the rectangle, when a p2lDistance to the rectangle's edge is added", async () => {
    // rectangle centred so its bottom-left corner sits exactly on the origin
    const r1 = rect("r1", 25, 10, 50, 20);
    const c1 = circ("c1", 12, 6, 3); // free-floating, not yet dimensioned to anything
    const cons: SketchConstraint[] = [
      { type: "fix", e: "o", p: 0 },
      { type: "distance", line: "r1~0", value: 50 }, // SK-2: W/H are real constraints
      { type: "distance", line: "r1~1", value: 20 },
      // circle centre to the rectangle's LEFT edge (r1~3), a value the circle's
      // CURRENT position does not already satisfy, so something has to move.
      { type: "p2lDistance", e: "c1", p: 0, line: "r1~3", value: 15 },
    ];
    const r = await compileAndSolve([originPt, r1, c1], cons);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const outRect = r.entities.find((e) => e.id === "r1") as { x: number; y: number; width: number; height: number };
    // unmoved: still centred at (25,10), the corner the origin point pinned
    expect(outRect.x).toBeCloseTo(25, 6);
    expect(outRect.y).toBeCloseTo(10, 6);
    expect(outRect.width).toBeCloseTo(50, 6);
    expect(outRect.height).toBeCloseTo(20, 6);
    const outCirc = r.entities.find((e) => e.id === "c1") as { x: number; y: number };
    expect(outCirc.x).toBeCloseTo(15, 6); // the circle took the new distance instead
  });

  it("merges the corner with the origin point rather than adding a second point at the same spot", async () => {
    const r1 = rect("r1", 25, 10, 50, 20);
    const cons: SketchConstraint[] = [{ type: "fix", e: "o", p: 0 }];
    const r = await compileAndSolve([originPt, r1], cons);
    expect(r.ok).toBe(true);
    // 4 DOF (2 free corners) minus the 2 the fixed corner removes: width and
    // height are still free, but that corner and the rectangle's orientation
    // are not, exactly what sharing the origin point's solver id predicts.
    expect(r.dof).toBe(2);
    const outRect = r.entities.find((e) => e.id === "r1") as { x: number; y: number };
    expect(outRect.x).toBeCloseTo(25, 6);
    expect(outRect.y).toBeCloseTo(10, 6);
  });
});
