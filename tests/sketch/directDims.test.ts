import { describe, it, expect } from "vitest";
import { applyDrivingDimsDirect, drivenBadges, drivingDimFor, upsertDrivingDim } from "../../src/sketch/directDims";
import type { ResolvedEntity } from "../../src/sketch/snap";
import { rectCorners } from "../../src/sketch/region";
import type { SketchConstraint } from "../../src/types";

const circle = (id: string, radius: number): ResolvedEntity => ({ type: "circle", id, radius, x: 0, y: 0 });
const line = (id: string, x2: number, y2: number): ResolvedEntity => ({ type: "line", id, x1: 0, y1: 0, x2, y2 });
const rect = (id: string, width: number, height: number): ResolvedEntity => ({ type: "rectangle", id, width, height, x: width / 2, y: height / 2 });

describe("applyDrivingDimsDirect", () => {
  // The reported bug: a circle keeps the size it was drawn at, because its
  // diameter is the one dimension that needs a solver and there isn't one.
  it("resizes a circle to its diameter constraint", () => {
    const ents = [circle("c1", 5)];
    const cons: SketchConstraint[] = [{ type: "diameter", circle: "c1", value: 20 }];
    expect(applyDrivingDimsDirect(ents, cons)).toBe(true);
    expect(ents[0]).toMatchObject({ radius: 10 });
  });

  it("sets a line's length along its existing direction, holding the start", () => {
    const ents = [line("l1", 3, 4)]; // length 5
    const cons: SketchConstraint[] = [{ type: "distance", line: "l1", value: 10 }];
    expect(applyDrivingDimsDirect(ents, cons)).toBe(true);
    const l = ents[0] as Extract<ResolvedEntity, { type: "line" }>;
    expect(l.x1).toBe(0);
    expect(l.y1).toBe(0);
    expect(Math.hypot(l.x2 - l.x1, l.y2 - l.y1)).toBeCloseTo(10, 9);
    // direction preserved: (3,4)/5 * 10 = (6,8)
    expect(l.x2).toBeCloseTo(6, 9);
    expect(l.y2).toBeCloseTo(8, 9);
  });

  it("reports no change when the geometry already matches", () => {
    const ents = [circle("c1", 10), line("l1", 10, 0)];
    const cons: SketchConstraint[] = [
      { type: "diameter", circle: "c1", value: 20 },
      { type: "distance", line: "l1", value: 10 },
    ];
    expect(applyDrivingDimsDirect(ents, cons)).toBe(false);
  });

  it("leaves two-entity dimensions alone rather than guessing which end moves", () => {
    const ents = [circle("c1", 5), circle("c2", 5)];
    const cons: SketchConstraint[] = [{ type: "c2cDistance", c1: "c1", c2: "c2", value: 50 }];
    expect(applyDrivingDimsDirect(ents, cons)).toBe(false);
    expect(ents[0]).toMatchObject({ radius: 5, x: 0, y: 0 });
    expect(ents[1]).toMatchObject({ radius: 5, x: 0, y: 0 });
  });

  it("ignores nonsense values and missing or mistyped targets", () => {
    const ents = [circle("c1", 5), line("l1", 0, 0)];
    const cons: SketchConstraint[] = [
      { type: "diameter", circle: "c1", value: 0 }, // zero
      { type: "diameter", circle: "c1", value: -4 }, // negative
      { type: "diameter", circle: "gone", value: 20 }, // no such entity
      { type: "diameter", circle: "l1", value: 20 }, // not a circle
      { type: "distance", line: "l1", value: 10 }, // zero-length: no direction
    ];
    expect(applyDrivingDimsDirect(ents, cons)).toBe(false);
    expect(ents[0]).toMatchObject({ radius: 5 });
    expect(ents[1]).toMatchObject({ x2: 0, y2: 0 });
  });

  it("applies every dimension it can in one pass", () => {
    const ents = [circle("c1", 1), circle("c2", 1), line("l1", 1, 0)];
    const cons: SketchConstraint[] = [
      { type: "diameter", circle: "c1", value: 8 },
      { type: "diameter", circle: "c2", value: 12 },
      { type: "distance", line: "l1", value: 7 },
    ];
    expect(applyDrivingDimsDirect(ents, cons)).toBe(true);
    expect(ents[0]).toMatchObject({ radius: 4 });
    expect(ents[1]).toMatchObject({ radius: 6 });
    expect(ents[2]).toMatchObject({ x2: 7 });
  });

  // The constraint is a record of intent and must survive, so the real solver
  // drives the same geometry the moment it is available.
  it("does not consume or alter the constraints", () => {
    const ents = [circle("c1", 5)];
    const cons: SketchConstraint[] = [{ type: "diameter", circle: "c1", value: 20 }];
    applyDrivingDimsDirect(ents, cons);
    expect(cons).toHaveLength(1);
    expect(cons[0]).toMatchObject({ type: "diameter", circle: "c1", value: 20 });
  });

  // Applying twice must not drift: re-running after a solve-less edit is normal.
  it("is idempotent", () => {
    const ents = [circle("c1", 5), line("l1", 3, 4)];
    const cons: SketchConstraint[] = [
      { type: "diameter", circle: "c1", value: 20 },
      { type: "distance", line: "l1", value: 10 },
    ];
    expect(applyDrivingDimsDirect(ents, cons)).toBe(true);
    expect(applyDrivingDimsDirect(ents, cons)).toBe(false);
    expect(ents[0]).toMatchObject({ radius: 10 });
    expect(ents[1]).toMatchObject({ x2: 6, y2: 8 });
  });
});

describe("upsertDrivingDim", () => {
  // SK-7: FeatureProperties has no live sketch session to route a length edit
  // through SketchMode.editDimension, so it has to build the same driving
  // constraint by hand before handing entities+constraints to a headless solve.
  it("adds a fresh distance constraint for a line's length, with a new id", () => {
    const l = line("l1", 3, 4);
    const out = upsertDrivingDim([], l, "length", 10);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({ type: "distance", line: "l1", value: 10 });
    expect((out![0] as { id?: string }).id).toBeTruthy();
  });

  it("adds a fresh diameter constraint for a circle's diameter", () => {
    const c = circle("c1", 5);
    const out = upsertDrivingDim([], c, "diameter", 20);
    expect(out).toMatchObject([{ type: "diameter", circle: "c1", value: 20 }]);
  });

  it("replaces the existing distance constraint on the same line, keeping its id", () => {
    const l = line("l1", 3, 4);
    const existing: SketchConstraint[] = [{ type: "distance", line: "l1", value: 5, id: "c9" }];
    const out = upsertDrivingDim(existing, l, "length", 12)!;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "distance", line: "l1", value: 12, id: "c9" });
  });

  it("leaves every other constraint untouched", () => {
    const l = line("l1", 3, 4);
    const existing: SketchConstraint[] = [
      { type: "horizontal", line: "other" } as SketchConstraint,
      { type: "distance", line: "l1", value: 5, id: "c9" },
    ];
    const out = upsertDrivingDim(existing, l, "length", 12)!;
    expect(out).toHaveLength(2);
    expect(out.find((k) => k.type === "horizontal")).toBeTruthy();
  });

  // MO-1: a width typed into a rectangle's label after drawing used to be a
  // coordinate write, so the next drag undid it and the DOF count never moved.
  it("turns a rectangle's width and height into driving p2pDistance dims on its own corners", () => {
    const r = rect("r1", 20, 10);
    const w = upsertDrivingDim([], r, "width", 42)!;
    expect(w).toMatchObject([{ type: "p2pDistance", e1: "r1", p1: 1, e2: "r1", p2: 0, value: 42 }]);
    const h = upsertDrivingDim(w, r, "height", 30)!;
    expect(h).toHaveLength(2);
    expect(h[1]).toMatchObject({ type: "p2pDistance", e1: "r1", p1: 0, e2: "r1", p2: 3, value: 30 });
  });

  it("updates a rectangle side already held by a typed-while-drawing dim instead of adding a second one", () => {
    const r = rect("r1", 20, 10);
    const existing: SketchConstraint[] = [{ type: "p2pDistance", e1: "r1", p1: 1, e2: "r1", p2: 2, value: 10, id: "c4" }];
    const out = upsertDrivingDim(existing, r, "height", 12)!;
    expect(out).toEqual([{ type: "p2pDistance", e1: "r1", p1: 1, e2: "r1", p2: 2, value: 12, id: "c4" }]);
  });

  it("hands a dragged badge placement to the constraint so the label stays put", () => {
    const r = { ...rect("r1", 20, 10), dimPlace: { width: { ox: 0, oy: -9 } } } as ResolvedEntity;
    expect(drivingDimFor(r, "width", 20)).toMatchObject({ place: { ox: 0, oy: -9 } });
  });

  it("leaves a rotated rectangle's sides as direct writes, the solver holds it rigid", () => {
    const r = { ...rect("r1", 20, 10), angle: 30 } as ResolvedEntity;
    expect(upsertDrivingDim([], r, "width", 42)).toBeNull();
  });

  it("returns null for a field that is not a line length, circle diameter or rectangle side", () => {
    const l = line("l1", 3, 4);
    expect(upsertDrivingDim([], l, "angle" as never, 10)).toBeNull();
    const c = circle("c1", 5);
    expect(upsertDrivingDim([], c, "radius" as never, 10)).toBeNull();
  });
});

describe("drivenBadges", () => {
  it("names the rectangle sides a driving dim holds, whichever corner pair it uses", () => {
    const ents = [rect("r1", 20, 10), rect("r2", 5, 5)];
    const cons: SketchConstraint[] = [
      { type: "p2pDistance", e1: "r1", p1: 2, e2: "r1", p2: 3, value: 20 },
      { type: "p2pDistance", e1: "r2", p1: 1, e2: "r2", p2: 2, value: 5, driven: true },
    ];
    expect([...drivenBadges(ents, cons)]).toEqual(["r1:width"]);
  });
});

describe("applyDrivingDimsDirect on a rectangle", () => {
  // Drawn from an origin pin in each direction: the pin lands on a different
  // corner each time, and that corner is the one that has to stay put.
  const fromOrigin = (sx: number, sy: number): ResolvedEntity[] => [
    { type: "rectangle", id: "r1", x: 10 * sx, y: 10 * sy, width: 20, height: 20 },
    { type: "point", id: "o", x: 0, y: 0, construction: true },
  ];
  const fix: SketchConstraint = { type: "fix", e: "o", p: 0 };
  const originCornerOf = (e: ResolvedEntity) => {
    const r = e as Extract<ResolvedEntity, { type: "rectangle" }>;
    return rectCorners(r.x, r.y, r.width, r.height).some((q) => Math.hypot(q.x, q.y) < 1e-9);
  };

  for (const [name, sx, sy] of [["up-right", 1, 1], ["down-right", 1, -1], ["up-left", -1, 1], ["down-left", -1, -1]] as const) {
    it(`keeps the pinned corner on the origin when drawn ${name}`, () => {
      const ents = fromOrigin(sx, sy);
      const cons: SketchConstraint[] = [
        fix,
        { type: "p2pDistance", e1: "r1", p1: 1, e2: "r1", p2: 0, value: 30 },
        { type: "p2pDistance", e1: "r1", p1: 0, e2: "r1", p2: 3, value: 40 },
      ];
      expect(applyDrivingDimsDirect(ents, cons)).toBe(true);
      expect(ents[0]).toMatchObject({ width: 30, height: 40 });
      expect(originCornerOf(ents[0]!)).toBe(true);
      const r = ents[0] as Extract<ResolvedEntity, { type: "rectangle" }>;
      expect(r.x).toBeCloseTo(15 * sx, 9);
      expect(r.y).toBeCloseTo(20 * sy, 9);
    });
  }

  it("with nothing pinned, holds the second corner of the constraint's own pair", () => {
    const ents: ResolvedEntity[] = [{ type: "rectangle", id: "r1", x: 50, y: 50, width: 20, height: 10 }];
    const cons: SketchConstraint[] = [{ type: "p2pDistance", e1: "r1", p1: 0, e2: "r1", p2: 1, value: 42 }];
    expect(applyDrivingDimsDirect(ents, cons)).toBe(true);
    expect(ents[0]).toMatchObject({ width: 42, height: 10, x: 39, y: 50 }); // corner 1 stays at (60, 45)
  });
});
