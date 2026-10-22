import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { defaultReach, gapReport, looseEnds, nothingToTiePrompt, tieConstraints } from "../../src/sketch/looseEnds";
import { detectRegions } from "../../src/sketch/region";
import { compileAndSolve } from "../../src/sketch/sketchSolve";
import { SketchHistory, cloneSnapshot, type SketchSnapshot } from "../../src/sketch/history";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

const L = (id: string, x1: number, y1: number, x2: number, y2: number, construction?: boolean): ResolvedEntity => ({
  type: "line",
  id,
  x1,
  y1,
  x2,
  y2,
  ...(construction ? { construction } : {}),
});
const co = (e1: string, p1: number, e2: string, p2: number): SketchConstraint => ({
  type: "coincident",
  e1,
  p1,
  e2,
  p2,
});
const refs = (xs: { entity: string; p: number }[]) => xs.map((u) => `${u.entity}:${u.p}`).sort();
const tri = (g = 0) => [L("a", 0, 0, 10, 0), L("b", 10, 0, 5, 8), L("c", 5, 8, 0, g)];

describe("looseEnds detection", () => {
  it("a triangle held by coincident constraints has no loose ends", () => {
    const le = looseEnds(tri(), [co("a", 1, "b", 0), co("b", 1, "c", 0), co("c", 1, "a", 0)], 0.1);
    expect(le).toEqual({ open: [], untied: [] });
  });

  it("ends that meet only by position are untied pairs, tied with one constraint each", () => {
    const le = looseEnds(tri(), [], 0.1);
    expect(le.open).toEqual([]);
    expect(refs(le.untied)).toEqual(["a:0", "a:1", "b:0", "b:1", "c:0", "c:1"]);
    expect(le.untied.every((u) => u.touches.kind === "end" && u.gap === 0 && u.tieable)).toBe(true);
    expect(tieConstraints(le)).toHaveLength(3);
  });

  it("a gap inside the reach is amber, outside it both ends are red", () => {
    const amber = looseEnds(tri(0.05), [co("a", 1, "b", 0), co("b", 1, "c", 0)], 0.1);
    expect(amber.open).toEqual([]);
    expect(refs(amber.untied)).toEqual(["a:0", "c:1"]);
    expect(amber.untied[0]!.gap).toBeCloseTo(0.05, 9);
    const red = looseEnds(tri(0.05), [co("a", 1, "b", 0), co("b", 1, "c", 0)], 0.01);
    expect(red.untied).toEqual([]);
    expect(refs(red.open)).toEqual(["a:0", "c:1"]);
  });

  it("a lone line has two open ends, with coordinates", () => {
    const le = looseEnds([L("a", 1, 2, 3, 4)], [], 0.1);
    expect(le.open).toEqual([
      { entity: "a", p: 0, x: 1, y: 2 },
      { entity: "a", p: 1, x: 3, y: 4 },
    ]);
  });

  it("an arc end near a line end ties with a coincident on the arc end", () => {
    const ents: ResolvedEntity[] = [
      L("l", -5, 0, 5, 0),
      { type: "arc", id: "r", x1: 5, y1: 0, x2: -5, y2: 0.02, mx: 0, my: 5 },
    ];
    const le = looseEnds(ents, [co("l", 1, "r", 0)], 0.1);
    expect(le.open).toEqual([]);
    const arcEnd = le.untied.find((u) => u.entity === "r")!;
    expect(arcEnd).toMatchObject({ p: 1, touches: { kind: "end", entity: "l", p: 0 }, tieable: true });
    expect(tieConstraints(le)).toEqual([co("l", 0, "r", 1)]);
  });

  it("an end just above the middle of a line is untied against the curve, tied by pointOnCurve", () => {
    const ents = [L("a", 0, 0, 10, 0), L("m", 5, 0.03, 5, 6)];
    const le = looseEnds(ents, [], 0.1);
    const m0 = le.untied.find((u) => u.entity === "m")!;
    expect(m0).toMatchObject({ p: 0, touches: { kind: "curve", entity: "a" }, tieable: true });
    expect(m0.gap).toBeCloseTo(0.03, 9);
    expect(tieConstraints(le)).toEqual([{ type: "pointOnCurve", e: "m", p: 0, curve: "a" }]);
  });

  it("splines: a curve touch is reported but not tieable, an end touch ties on the spline end", () => {
    const sp: ResolvedEntity = {
      type: "spline",
      id: "s",
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 3 },
        { x: 10, y: 0 },
      ],
    };
    const onBody = looseEnds([sp, L("m", 5, 6, 5, 3.04)], [], 0.2).untied.find((u) => u.entity === "m")!;
    expect(onBody).toMatchObject({ p: 1, touches: { kind: "curve", entity: "s" }, tieable: false });
    expect(tieConstraints({ open: [], untied: [onBody] })).toEqual([]);
    const le = looseEnds([sp, L("m", 10.01, 0, 20, 0)], [], 0.1);
    expect(le.untied.find((u) => u.entity === "m")!.touches).toEqual({ kind: "end", entity: "s", p: 1 });
  });

  it("an open bspline exposes its first and last pole as ends 0 and 1, a closed one has none", () => {
    const poles = [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 6, y: 4 },
      { x: 9, y: 0 },
    ];
    const le = looseEnds([{ type: "bspline", id: "b", poles }], [], 0.1);
    expect(le.open).toEqual([
      { entity: "b", p: 0, x: 0, y: 0 },
      { entity: "b", p: 1, x: 9, y: 0 },
    ]);
    expect(looseEnds([{ type: "bspline", id: "b", poles, closed: true }], [], 0.1)).toEqual({ open: [], untied: [] });
  });

  it("a free form curve may close onto itself, a line never does", () => {
    const sp: ResolvedEntity = {
      type: "spline",
      id: "s",
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 0 },
        { x: 0.02, y: 0 },
      ],
    };
    expect(tieConstraints(looseEnds([sp], [], 0.1))).toEqual([co("s", 0, "s", 1)]);
    expect(refs(looseEnds([L("a", 0, 0, 0.05, 0)], [], 0.1).open)).toEqual(["a:0", "a:1"]);
  });

  it("a rectangle corner is a target, rectangles and circles have no ends of their own", () => {
    const ents: ResolvedEntity[] = [
      { type: "rectangle", id: "r", x: 5, y: 2.5, width: 10, height: 5 },
      { type: "circle", id: "c", x: 30, y: 0, radius: 2 },
      L("l", 10.02, 5.01, 20, 9),
    ];
    const le = looseEnds(ents, [], 0.1);
    expect(le.open).toEqual([{ entity: "l", p: 1, x: 20, y: 9 }]);
    const [u] = le.untied;
    expect(u!.touches.kind).toBe("end");
    const t = tieConstraints(le)[0] as Extract<SketchConstraint, { type: "coincident" }>;
    expect(t.e2).toBe("r");
  });

  it("construction ends never count, a projected line is a target and never a loose end", () => {
    const ents: ResolvedEntity[] = [
      L("k", 0, 0, 3, 3, true),
      {
        type: "projected",
        id: "p",
        source: { kind: "sketchCurve", sketch: "s0", entity: "e0" },
        curve: { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
      },
      L("l", 10, 0.01, 10, 5),
    ];
    const le = looseEnds(ents, [], 0.1);
    expect(le.open).toEqual([{ entity: "l", p: 1, x: 10, y: 5 }]);
    expect(le.untied).toHaveLength(1);
    expect(le.untied[0]).toMatchObject({ entity: "l", p: 0, touches: { kind: "end", entity: "p", p: 1 } });
  });

  it("a coincident chain through one corner ties every end on it", () => {
    const ents = [L("a", 0, 0, 5, 0), L("b", 5, 0, 5, 5), L("c", 5, 0, 9, -3)];
    const le = looseEnds(ents, [co("a", 1, "b", 0), co("b", 0, "c", 0)], 0.1);
    expect(le.untied).toEqual([]);
    expect(refs(le.open)).toEqual(["a:0", "b:1", "c:1"]);
  });

  it("three untied ends at one corner get two coincidents, never a redundant ring", () => {
    const ents = [L("a", 0, 0, 5, 0), L("b", 5, 0, 5, 5), L("c", 5, 0, 9, -3)];
    expect(tieConstraints(looseEnds(ents, [], 0.1))).toHaveLength(2);
  });

  it("a coincident to a sketch point leaves the curve end loose", () => {
    const ents: ResolvedEntity[] = [L("a", 0, 0, 5, 0), { type: "point", id: "pt", x: 5, y: 0 }];
    expect(refs(looseEnds(ents, [co("a", 1, "pt", 0)], 0.1).open)).toEqual(["a:0", "a:1"]);
  });

  it("a coincident or pointOnCurve onto construction geometry leaves the end open", () => {
    const ents = [L("a", 0, 0, 5, 0), L("k", 5, 0, 5, 5, true), L("m", 0, 3, 9, 3, true)];
    const le = looseEnds(ents, [co("a", 1, "k", 0)], 0.1);
    expect(refs(le.open)).toEqual(["a:0", "a:1"]);
    const on = looseEnds(
      [L("a", 0, 0, 5, 3), L("m", 0, 3, 9, 3, true)],
      [{ type: "pointOnCurve", e: "a", p: 1, curve: "m" }],
      0.1,
    );
    expect(refs(on.open)).toEqual(["a:0", "a:1"]);
  });

  it("a coincident onto an arc centre leaves the end open", () => {
    const ents: ResolvedEntity[] = [
      L("a", -9, 0, 0, 0),
      { type: "arc", id: "r", x1: 5, y1: 0, x2: -5, y2: 0, mx: 0, my: 5 },
    ];
    const le = looseEnds(ents, [co("a", 1, "r", 2)], 0.1);
    expect(refs(le.open)).toEqual(["a:0", "a:1", "r:0"]);
    expect(refs(le.untied)).toEqual(["r:1"]);
  });

  it("among thousands of curves a near miss on a long line or a big circle is still found", () => {
    const ents: ResolvedEntity[] = Array.from({ length: 3000 }, (_, i) =>
      L("s" + i, (i % 60) * 10, Math.floor(i / 60) * 10, (i % 60) * 10 + 4, Math.floor(i / 60) * 10 + 3),
    );
    ents.push(L("long", 0, -50, 1000, -50), L("t", 500, -49.95, 500, -40));
    ents.push({ type: "circle", id: "c", x: 2000, y: 0, radius: 100 }, L("u", 2100.05, 0, 2150, 0));
    const le = looseEnds(ents, [], 0.1);
    expect(le.untied.map((u) => [u.entity, u.p, u.touches])).toEqual([
      ["t", 0, { kind: "curve", entity: "long" }],
      ["u", 0, { kind: "curve", entity: "c" }],
    ]);
    expect(le.open).toHaveLength(6004);
  });

  it("two ends held at one construction end are tied to each other", () => {
    const ents = [L("a", 0, 0, 5, 0), L("b", 5, 0, 5, 5), L("k", 5, 0, 9, 9, true)];
    const le = looseEnds(ents, [co("a", 1, "k", 0), co("k", 0, "b", 0)], 0.1);
    expect(refs(le.open)).toEqual(["a:0", "b:1"]);
    expect(le.untied).toEqual([]);
  });
});

describe("tying loose ends closes the profile", () => {
  it("a DXF style near miss shows no profile until its loose ends are tied", async () => {
    const sq = [L("a", 0, 0, 10, 0), L("b", 10, 0, 10, 8), L("c", 10, 8, 0, 8), L("d", 0, 8, 0.02, 0.01)];
    expect(detectRegions("s", sq)).toHaveLength(0);
    const le = looseEnds(sq, [], 0.1);
    expect(le.open).toEqual([]);
    expect(refs(le.untied)).toEqual(["a:0", "a:1", "b:0", "b:1", "c:0", "c:1", "d:0", "d:1"]);
    const cs = tieConstraints(le);
    expect(cs).toHaveLength(4);
    const r = await compileAndSolve(sq, cs);
    expect(r.conflicts).toEqual([]);
    expect(detectRegions("s", r.entities)).toHaveLength(1);
    expect(looseEnds(r.entities, cs, 0.1)).toEqual({ open: [], untied: [] });
  });

  // 4e-5 already fills a region in the sketcher, yet the engine refuses to
  // extrude anything over 1e-7, so the tie must leave the two ends bit equal
  it("a gap below the region weld is still amber and the tie makes the ends exactly equal", async () => {
    const sq = [L("a", 0, 0, 10, 0), L("b", 10, 0, 10, 8), L("c", 10, 8, 0, 8), L("d", 0, 8, 0, 4e-5)];
    const ties = [co("a", 1, "b", 0), co("b", 1, "c", 0), co("c", 1, "d", 0)];
    expect(detectRegions("s", sq)).toHaveLength(1);
    const le = looseEnds(sq, ties, 0.1);
    expect(refs(le.untied)).toEqual(["a:0", "d:1"]);
    const r = await compileAndSolve(sq, [...ties, ...tieConstraints(le, ties)]);
    expect(r.conflicts).toEqual([]);
    const a = r.entities.find((e) => e.id === "a") as Extract<ResolvedEntity, { type: "line" }>;
    const d = r.entities.find((e) => e.id === "d") as Extract<ResolvedEntity, { type: "line" }>;
    expect(d.x2).toBe(a.x1);
    expect(d.y2).toBe(a.y1);
  });

  // mirrors SketchMode.tieLooseEnds: push the ties, requestSolve banks the pre
  // edit state, the solver write back re-arms without banking
  it("the tie and its solve are one undo step", async () => {
    const sq = [L("a", 0, 0, 10, 0), L("b", 10, 0, 10, 8), L("c", 10, 8, 0, 8), L("d", 0, 8, 0.02, 0.01)];
    const snap = (entities: ResolvedEntity[], constraints: SketchConstraint[]): SketchSnapshot => ({
      entities,
      constraints,
      patterns: [],
    });
    const before = cloneSnapshot(snap(sq, []));
    const h = new SketchHistory();
    h.reset(before);
    const cs = tieConstraints(looseEnds(sq, [], 0.1));
    expect(h.bankIfChanged(snap(sq, cs))).toBe(true);
    const r = await compileAndSolve(sq, cs);
    const after = snap(r.entities, cs);
    h.arm(after);
    expect(h.depth).toBe(1);
    expect(h.undo(after)).toEqual(before);
    expect(h.canUndo).toBe(false);
  });
});

// A 50 mm square whose last side stops `gap` short of the first corner, the
// closed corners held as the sketcher's snaps hold them.
const square = (gap: number) => [
  L("a", 0, 0, 50, 0),
  L("b", 50, 0, 50, 50),
  L("c", 50, 50, 0, 50),
  L("d", 0, 50, 0, gap),
];
const corners = [co("a", 1, "b", 0), co("b", 1, "c", 0), co("c", 1, "d", 0)];
const report = (ents: ResolvedEntity[], cs: SketchConstraint[]) => gapReport(ents, cs, defaultReach(ents));

describe("gap report: a profile with a gap or an open sketch", () => {
  it("a gap within the snap reach is tieable as before", () => {
    expect(report(square(0.05), corners).kind).toBe("tieable");
  });

  it("a 3 mm gap on a 50 mm square is a gap, beyond the 0.7 mm snap reach", () => {
    const r = report(square(3), corners);
    expect(r.kind).toBe("gap");
    expect(r.open).toBe(2);
    expect(r.gapMm).toBeCloseTo(3, 6);
    expect(r.reach).toBeGreaterThanOrEqual(3);
    const ties = tieConstraints(looseEnds(square(3), corners, r.reach), corners);
    expect(ties).toEqual([co("a", 0, "d", 1)]);
  });

  it("an L with ends 70 mm apart is clearly open", () => {
    const ell = [L("a", 0, 0, 50, 0), L("b", 50, 0, 50, 50)];
    expect(report(ell, [co("a", 1, "b", 0)]).kind).toBe("open");
  });

  it("a U whose ends are a whole side apart is open", () => {
    const u = [L("a", 0, 0, 50, 0), L("b", 50, 0, 50, 50), L("d", 0, 50, 0, 0)];
    expect(report(u, [co("a", 1, "b", 0), co("d", 1, "a", 0)]).kind).toBe("open");
  });

  it("a closed square has nothing loose", () => {
    expect(report(square(0), [...corners, co("d", 1, "a", 0)]).kind).toBe("none");
  });
});

describe("Tie Loose Ends with nothing in reach", () => {
  it("never says there are no loose ends while red open ends show", () => {
    const le = looseEnds(square(3), corners, 0.7);
    const msg = nothingToTiePrompt(le, report(square(3), corners));
    expect(msg).not.toMatch(/No loose ends/);
    expect(msg).toMatch(/^2 open ends 3 mm apart, too far apart to tie/);
  });

  it("an open L says how many open ends and that they are too far apart", () => {
    const ell = [L("a", 0, 0, 50, 0), L("b", 50, 0, 50, 50)];
    const cs = [co("a", 1, "b", 0)];
    expect(nothingToTiePrompt(looseEnds(ell, cs, 0.7), report(ell, cs))).toMatch(/^2 open ends, too far apart to tie/);
  });

  it("a closed sketch still says there is nothing to tie", () => {
    const cs = [...corners, co("d", 1, "a", 0)];
    expect(nothingToTiePrompt(looseEnds(square(0), cs, 0.7), report(square(0), cs))).toBe("No loose ends to tie");
  });
});
