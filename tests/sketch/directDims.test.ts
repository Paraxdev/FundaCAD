import { describe, it, expect } from "vitest";
import { applyDrivingDimsDirect, upsertDrivingDim } from "../../src/sketch/directDims";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

const circle = (id: string, radius: number): ResolvedEntity => ({ type: "circle", id, radius, x: 0, y: 0 });
const line = (id: string, x2: number, y2: number): ResolvedEntity => ({ type: "line", id, x1: 0, y1: 0, x2, y2 });

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

  // rectangle W/H, line angle, radius, slot length/width, ... : none of these
  // go through a constraint even inside a live sketch session, so the caller
  // falls back to entityDims' direct write for them.
  it("returns null for a field that is not line length or circle diameter", () => {
    const l = line("l1", 3, 4);
    expect(upsertDrivingDim([], l, "angle" as never, 10)).toBeNull();
    const c = circle("c1", 5);
    expect(upsertDrivingDim([], c, "radius" as never, 10)).toBeNull();
  });
});
