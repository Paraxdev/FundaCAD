// What a line or arc being drawn is recorded with, decided before the click.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  bindNew,
  inferArcRelations,
  inferLineRelations,
  NEW_ENTITY,
  tangentArcMid,
  type InferLineInput,
} from "../../src/sketch/inferRelations";
import { leaveDirection } from "../../src/sketch/inferRelations";
import type { ResolvedEntity } from "../../src/sketch/snap";

const V = (x: number, y: number) => new THREE.Vector2(x, y);
const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({
  type: "line",
  id,
  x1,
  y1,
  x2,
  y2,
});
const deg = (d: number) => (d * Math.PI) / 180;
const polar = (o: THREE.Vector2, len: number, d: number) =>
  V(o.x + len * Math.cos(deg(d)), o.y + len * Math.sin(deg(d)));

const base = (over: Partial<InferLineInput>): InferLineInput => ({
  id: NEW_ENTITY,
  start: V(0, 0),
  end: V(10, 10),
  endKind: "free",
  entities: [],
  step: 0,
  tolDeg: 3,
  nearMm: 100,
  smart: true,
  ...over,
});
const types = (r: { relations: { type: string }[] }) => r.relations.map((c) => c.type);
const join = (e1: string, p1: number, e2: string, p2: number) => ({ type: "coincident", e1, p1, e2, p2, snap: true });

describe("line inference", () => {
  const A = line("A", 0, 0, 34.641, 20); // 30 degrees
  const start = V(34.641, 20);

  it("continuing a line within the tolerance is collinear and lands exactly on its direction", () => {
    const raw = polar(start, 30, 31.5);
    const r = inferLineRelations(base({ start, startRef: { entity: "A", at: 1 }, end: raw, raw, entities: [A] }));
    expect(r.relations).toEqual([join(NEW_ENTITY, 0, "A", 1), { type: "collinear", l1: "A", l2: NEW_ENTITY }]);
    const a = Math.atan2(r.end.y - start.y, r.end.x - start.x);
    expect(a).toBeCloseTo(Math.atan2(20, 34.641), 9);
    expect(r.glyphs).toEqual(["collinear"]);
  });

  it("leaving an arc end along its tangent records tangent2", () => {
    // eighth arc from (10,0) round to 45 degrees, centre origin, ends heading 135 degrees
    const e = polar(V(0, 0), 10, 45),
      m = polar(V(0, 0), 10, 22.5);
    const R: ResolvedEntity = { type: "arc", id: "R", x1: 10, y1: 0, x2: e.x, y2: e.y, mx: m.x, my: m.y };
    const raw = polar(e, 20, 136.5);
    const r = inferLineRelations(base({ start: e, startRef: { entity: "R", at: 1 }, end: raw, raw, entities: [R] }));
    expect(r.relations).toEqual([join(NEW_ENTITY, 0, "R", 1), { type: "tangent2", a: NEW_ENTITY, b: "R" }]);
    expect(Math.atan2(r.end.y - e.y, r.end.x - e.x)).toBeCloseTo(deg(135), 9);
    expect(r.glyphs).toEqual(["tangent"]);
  });

  it("horizontal is preferred over a collinear continuation of a horizontal line", () => {
    const H = line("H", 0, 0, 40, 0);
    const raw = V(80, 1);
    const r = inferLineRelations(
      base({ start: V(40, 0), startRef: { entity: "H", at: 1 }, end: raw, raw, entities: [H] }),
    );
    expect(types(r)).toEqual(["coincident", "horizontal"]);
    expect(r.end.y).toBe(0);
  });

  it("parallel and perpendicular to a nearby line, with its hint line", () => {
    const par = inferLineRelations(base({ start: V(0, 50), end: polar(V(0, 50), 30, 32), entities: [A] }));
    expect(par.relations).toEqual([{ type: "parallel", l1: "A", l2: NEW_ENTITY }]);
    expect(Math.atan2(par.end.y - 50, par.end.x)).toBeCloseTo(deg(30), 4);
    expect(par.hints).toHaveLength(1);
    const per = inferLineRelations(base({ start: V(0, 50), end: polar(V(0, 50), 30, 118.5), entities: [A] }));
    expect(per.relations).toEqual([{ type: "perpendicular", l1: "A", l2: NEW_ENTITY }]);
  });

  it("nothing outside the tolerance", () => {
    const r = inferLineRelations(base({ start: V(0, 50), end: polar(V(0, 50), 30, 40), entities: [A] }));
    expect(r.relations).toEqual([]);
    expect(r.glyphs).toEqual([]);
  });

  it("ending on a midpoint records midpoint, on a curve records pointOnCurve, and neither moves the end", () => {
    const L = line("L", 0, 0, 40, 0);
    const end = V(20, 0);
    const mid = inferLineRelations(
      base({ start: V(5, 30), end, endKind: "midpoint", endRef: { entity: "L", at: "mid" }, entities: [L] }),
    );
    expect(mid.relations).toEqual([{ type: "midpoint", e: NEW_ENTITY, p: 1, line: "L" }]);
    expect(mid.end).toEqual(end);
    const on = inferLineRelations(
      base({ start: V(5, 30), end: V(12, 0), endKind: "curve", endRef: { entity: "L", at: "curve" }, entities: [L] }),
    );
    expect(on.relations).toEqual([{ type: "pointOnCurve", e: NEW_ENTITY, p: 1, curve: "L" }]);
    const start = inferLineRelations(
      base({ start: V(20, 0), startRef: { entity: "L", at: "mid" }, end: V(30, 25), entities: [L] }),
    );
    expect(start.relations).toEqual([{ type: "midpoint", e: NEW_ENTITY, p: 0, line: "L" }]);
  });

  it("an end on an anchor records the join and only an exact axis, never a guessed one", () => {
    const L = line("L", 0, 0, 40, 0);
    const r = inferLineRelations(
      base({ start: V(0, 30), end: V(1, 0), endKind: "endpoint", endRef: { entity: "L", at: 0 }, entities: [L] }),
    );
    expect(r.relations).toEqual([join(NEW_ENTITY, 1, "L", 0)]);
    expect(r.glyphs).toEqual(["coincident"]);
  });

  it("with Snap off only the horizontal and vertical rules are left", () => {
    const raw = polar(start, 30, 31.5);
    const off = inferLineRelations(
      base({ start, startRef: { entity: "A", at: 1 }, end: raw, raw, entities: [A], smart: false }),
    );
    expect(off.relations).toEqual([]);
    const mid = inferLineRelations(
      base({
        start: V(5, 30),
        end: V(20, 0),
        endKind: "midpoint",
        endRef: { entity: "A", at: "mid" },
        entities: [A],
        smart: false,
      }),
    );
    expect(mid.relations).toEqual([]);
    const h = inferLineRelations(base({ start: V(0, 0), end: V(50, 1), smart: false }));
    expect(types(h)).toEqual(["horizontal"]);
  });

  it("a typed angle takes no direction guess", () => {
    const r = inferLineRelations(base({ start: V(0, 0), end: V(50, 1), typedAngle: true }));
    expect(r.relations).toEqual([]);
  });

  it("a lattice snapped end stays on the lattice, a guess is only recorded when exact", () => {
    const B = line("B", 0, 100, 200, 106);
    const par = inferLineRelations(
      base({ start: V(0, 0), end: V(200, 5), raw: V(199.9, 5.7), step: 5, nearMm: 150, entities: [B] }),
    );
    expect(par.end.toArray()).toEqual([200, 5]);
    expect(par.relations).toEqual([]);
    expect(par.hints).toEqual([]);
    const C = line("C", 0, 0, 100, 10);
    const ref = { entity: "C", at: 1 as const };
    const off = inferLineRelations(
      base({ start: V(100, 10), startRef: ref, end: V(190, 20), raw: V(190.3, 19.2), step: 10, entities: [C] }),
    );
    expect(off.end.toArray()).toEqual([190, 20]);
    expect(off.relations).toEqual([join(NEW_ENTITY, 0, "C", 1)]);
    const exact = inferLineRelations(
      base({ start: V(100, 10), startRef: ref, end: V(200, 20), raw: V(200.4, 20.9), step: 10, entities: [C] }),
    );
    expect(exact.end.toArray()).toEqual([200, 20]);
    expect(exact.relations).toEqual([join(NEW_ENTITY, 0, "C", 1), { type: "collinear", l1: "C", l2: NEW_ENTITY }]);
  });

  it("parallel and perpendicular only look at lines near the new one", () => {
    const far = line("F", 7000, 7000, 7000 + 100 * Math.cos(deg(30.2)), 7000 + 100 * Math.sin(deg(30.2)));
    const r = inferLineRelations(base({ start: V(0, 0), end: polar(V(0, 0), 50, 31), entities: [far] }));
    expect(r.relations).toEqual([]);
    expect(r.hints).toEqual([]);
    const near = inferLineRelations(
      base({
        start: V(0, 0),
        end: polar(V(0, 0), 50, 31),
        entities: [line("N", 0, 40, 100 * Math.cos(deg(30.2)), 40 + 100 * Math.sin(deg(30.2)))],
      }),
    );
    expect(types(near)).toEqual(["parallel"]);
  });

  it("a start snapped onto an end records the join but the cursor tag leaves it out", () => {
    const H = line("H", 0, 0, 40, 0);
    const r = inferLineRelations(
      base({ start: V(40, 0), startRef: { entity: "H", at: 1 }, end: V(55, 37), entities: [H] }),
    );
    expect(r.relations).toEqual([join(NEW_ENTITY, 0, "H", 1)]);
    expect(r.glyphs).toEqual([]);
  });

  it("a snap onto a rectangle corner, a circle centre or a point records the join to it", () => {
    const R: ResolvedEntity = { type: "rectangle", id: "Q", x: 0, y: 0, width: 20, height: 10 };
    const C: ResolvedEntity = { type: "circle", id: "C", x: 50, y: 0, radius: 5 };
    const P: ResolvedEntity = { type: "point", id: "P", x: 80, y: 0 };
    const ents = [R, C, P];
    for (const [entity, at] of [
      ["Q", 2],
      ["C", 0],
      ["P", 0],
    ] as const) {
      const r = inferLineRelations(
        base({ start: V(0, 60), end: V(1, 1), endKind: "endpoint", endRef: { entity, at }, entities: ents }),
      );
      expect(r.relations).toEqual([join(NEW_ENTITY, 1, entity, at)]);
    }
  });

  it("bindNew names the committed entity", () => {
    expect(bindNew([{ type: "collinear", l1: "A", l2: NEW_ENTITY }], "B")).toEqual([
      { type: "collinear", l1: "A", l2: "B" },
    ]);
  });
});

describe("arc inference", () => {
  const L = line("L", 0, 0, 20, 0);

  it("a tangent arc leaves the line along its direction and ends on the click", () => {
    const m = tangentArcMid(V(20, 0), V(1, 0), V(30, 10))!;
    const arc: ResolvedEntity = { type: "arc", id: "X", x1: 20, y1: 0, x2: 30, y2: 10, mx: m.x, my: m.y };
    const d = leaveDirection(arc, 0)!;
    expect(d.x).toBeCloseTo(1, 9);
    expect(d.y).toBeCloseTo(0, 9);
    expect(tangentArcMid(V(20, 0), V(1, 0), V(40, 0))).toBeNull();
  });

  it("a three point arc started nearly tangent is bent tangent and records tangent2", () => {
    // a 2 degree miss of the tangent arc through (30,10)
    const exact = tangentArcMid(V(20, 0), V(1, 0), V(30, 10))!;
    const off = exact.clone().sub(V(20, 0)).rotateAround(V(0, 0), deg(1)).add(V(20, 0));
    const r = inferArcRelations(
      "X",
      { x1: 20, y1: 0, x2: 30, y2: 10, mx: off.x, my: off.y },
      { entity: "L", at: 1 },
      null,
      [L],
      3,
      true,
    );
    expect(r.relations).toEqual([join("X", 0, "L", 1), { type: "tangent2", a: "X", b: "L" }]);
    expect(r.mid.distanceTo(exact)).toBeLessThan(1e-9);
  });

  it("a three point arc well off the tangent records only its join, and Snap off records nothing", () => {
    const r = inferArcRelations(
      "X",
      { x1: 20, y1: 0, x2: 30, y2: 10, mx: 22, my: 8 },
      { entity: "L", at: 1 },
      null,
      [L],
      3,
      true,
    );
    expect(r.relations).toEqual([join("X", 0, "L", 1)]);
    const exact = tangentArcMid(V(20, 0), V(1, 0), V(30, 10))!;
    const off = inferArcRelations(
      "X",
      { x1: 20, y1: 0, x2: 30, y2: 10, mx: exact.x, my: exact.y },
      { entity: "L", at: 1 },
      null,
      [L],
      3,
      false,
    );
    expect(off.relations).toEqual([]);
  });
});

describe("a typed size fixes the end", () => {
  const L = line("L", 0, 0, 40, 0);
  const onMid = {
    start: V(5, 30),
    end: V(20, 0),
    endKind: "midpoint" as const,
    endRef: { entity: "L", at: "mid" as const },
    entities: [L],
  };

  it("a typed length drops the midpoint, on-curve and join the hovered end would take", () => {
    expect(inferLineRelations(base({ ...onMid, typedLength: true })).relations).toEqual([]);
    const on = inferLineRelations(
      base({ ...onMid, end: V(12, 0), endKind: "curve", endRef: { entity: "L", at: "curve" }, typedLength: true }),
    );
    expect(on.relations).toEqual([]);
    const pt = inferLineRelations(
      base({ ...onMid, end: V(0, 0), endKind: "endpoint", endRef: { entity: "L", at: 0 }, typedLength: true }),
    );
    expect(pt.relations).toEqual([]);
  });

  it("a typed angle drops them too, and the start join stays", () => {
    expect(inferLineRelations(base({ ...onMid, typedAngle: true })).relations).toEqual([]);
    const r = inferLineRelations(
      base({ ...onMid, start: V(0, 10), startRef: { entity: "L", at: 0 }, typedLength: true }),
    );
    expect(r.relations).toEqual([join(NEW_ENTITY, 0, "L", 0)]);
  });
});

describe("rectangle edges as references", () => {
  const R: ResolvedEntity = { type: "rectangle", id: "R", width: 40, height: 20, x: 0, y: 0, angle: 30 };

  it("a line near a rotated rectangle is parallel to one of its edges, either pair", () => {
    const par = inferLineRelations(base({ start: V(0, 50), end: polar(V(0, 50), 30, 32), entities: [R] }));
    expect(par.relations).toEqual([{ type: "parallel", l1: expect.stringMatching(/^R~[02]$/), l2: NEW_ENTITY }]);
    const per = inferLineRelations(base({ start: V(0, 50), end: polar(V(0, 50), 30, 118.5), entities: [R] }));
    expect(per.relations).toEqual([{ type: "parallel", l1: expect.stringMatching(/^R~[13]$/), l2: NEW_ENTITY }]);
    expect(par.hints).toHaveLength(1);
  });
});
