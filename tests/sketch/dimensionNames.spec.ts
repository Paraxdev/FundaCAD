// Every dimension badge carries the subject key, the name and the shapes the Dimensions list shows. Real SketchMode
// constraintDimExtras off the prototype, the real facade and annotation store.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { SketchMode } from "../../src/sketch/sketchMode";
import { SketchDimensions } from "../../src/sketch/sketchDimensions";
import { constraintDims } from "../../src/sketch/entityDims";
import { drivenBadges } from "../../src/sketch/directDims";
import { useSketchAnnotationStore } from "../../src/stores/sketchAnnotations";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchPlane } from "../../src/sketch/plane";
import type { Viewport } from "../../src/viewport/viewport";
import type { SketchConstraint } from "../../src/types";

vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

beforeEach(() => setActivePinia(createPinia()));

const plane = { to3D: (x: number, y: number, out: THREE.Vector3) => out.set(x, y, 0) } as unknown as SketchPlane;
const viewport = { rig: { poseVersion: () => 0 } } as unknown as Viewport;

const rect = (id: string, x: number, y: number, width: number, height: number): ResolvedEntity => ({
  type: "rectangle",
  id,
  x,
  y,
  width,
  height,
});
const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({
  type: "line",
  id,
  x1,
  y1,
  x2,
  y2,
});

const ENTS: ResolvedEntity[] = [
  rect("r1", 33.5, 17.2, 20, 10),
  rect("r2", -14, 9.5, 8, 6),
  { type: "circle", id: "c1", x: 41, y: -7, radius: 3.5 },
  line("l1", 20, 3, 26, 5),
  line("l2", 26, 5, 21, 9),
];

function extras(constraints: SketchConstraint[], ents = ENTS) {
  const s = Object.create(SketchMode.prototype) as { constraintDimExtras(): ReturnType<typeof Array.of> };
  Object.assign(s, {
    entities: ents,
    constraints,
    cdims: constraintDims(ents, constraints),
    conflictIdx: new Set<number>(),
    overIdx: new Set<number>(),
    exprFor: () => undefined,
  });
  return s.constraintDimExtras() as {
    key: string;
    name: string;
    entities: string[];
    driven?: boolean;
  }[];
}

describe("entity dimension keys and names", () => {
  it("names every badge by its measure and its shape's place among its kind", () => {
    new SketchDimensions(viewport, () => {}).show(ENTS, plane);
    const items = useSketchAnnotationStore().dimItems;
    expect(items.map((i) => [i.key, i.name, i.entities])).toEqual([
      ["r1:width", "Width of Rectangle 1", ["r1"]],
      ["r1:height", "Height of Rectangle 1", ["r1"]],
      ["r2:width", "Width of Rectangle 2", ["r2"]],
      ["r2:height", "Height of Rectangle 2", ["r2"]],
      ["c1:diameter", "Diameter of Circle 1", ["c1"]],
      ["l1:length", "Length of Line 1", ["l1"]],
      ["l2:length", "Length of Line 2", ["l2"]],
    ]);
  });

  it("shows no badges for a second sketch's empty shape list", () => {
    const dims = new SketchDimensions(viewport, () => {});
    dims.show(ENTS, plane);
    dims.show([], plane);
    expect(useSketchAnnotationStore().dimItems).toEqual([]);
  });
});

describe("constraint dimension keys and names", () => {
  it("keeps a rectangle side's key when its edit turns it into a driving constraint", () => {
    const dims = new SketchDimensions(viewport, () => {});
    dims.show(ENTS, plane);
    const before = useSketchAnnotationStore().dimItems.find((i) => i.key === "r2:width")!;

    const side: SketchConstraint = { type: "p2pDistance", e1: "r2", p1: 0, e2: "r2", p2: 1, value: 11, id: "k1" };
    const [c] = extras([side]);
    dims.show(ENTS, plane, extras([side]) as never, drivenBadges(ENTS, [side]));
    const after = useSketchAnnotationStore().dimItems.filter((i) => i.key === "r2:width");

    expect(after).toHaveLength(1);
    expect(c).toMatchObject({ key: before.key, name: before.name, entities: ["r2"] });
  });

  it("keys a second driving width on one rectangle by its constraint, so no two rows share a key", () => {
    const cs: SketchConstraint[] = [
      { type: "p2pDistance", e1: "r1", p1: 0, e2: "r1", p2: 1, value: 20, id: "k3" },
      { type: "p2pDistance", e1: "r1", p1: 3, e2: "r1", p2: 2, value: 20, id: "k4" },
      { type: "p2pDistance", e1: "r1", p1: 2, e2: "r1", p2: 1, value: 10 },
      { type: "p2pDistance", e1: "r2", p1: 1, e2: "r2", p2: 0, value: 8, id: "k5" },
    ];
    expect(extras(cs).map((d) => [d.key, d.name])).toEqual([
      ["r1:width", "Width of Rectangle 1"],
      ["c:k4", "Width of Rectangle 1"],
      ["r1:height", "Height of Rectangle 1"],
      ["r2:width", "Width of Rectangle 2"],
    ]);
  });

  it("reads a reference side as its own subject, not as the side", () => {
    const side: SketchConstraint = {
      type: "p2pDistance",
      e1: "r1",
      p1: 1,
      e2: "r1",
      p2: 2,
      value: 10,
      driven: true,
      id: "k2",
    };
    expect(extras([side])).toMatchObject([{ key: "c:k2", name: "Distance of Rectangle 1", driven: true }]);
  });

  it("names one, two operands, and keys a constraint without an id by its place", () => {
    const cons: SketchConstraint[] = [
      { type: "radius", e: "a1", value: 6 },
      { type: "angle", l1: "l1", l2: "l2", value: 70 },
      { type: "p2pDistance", e1: "l1", p1: 1, e2: "l2", p2: 1, value: 4.5, id: "k7" },
    ];
    const arc: ResolvedEntity = { type: "arc", id: "a1", x1: 52, y1: 3, x2: 46, y2: 9, mx: 50, my: 7.5 };
    const got = extras(cons, [...ENTS, arc]);
    expect(got.map((g) => [g.key, g.name, g.entities])).toEqual([
      ["c:#0", "Radius of Arc 1", ["a1"]],
      ["c:#1", "Angle between Line 1 and Line 2", ["l1", "l2"]],
      ["c:k7", "Distance between Line 1 and Line 2", ["l1", "l2"]],
    ]);
  });

  it("decodes a rectangle edge operand to its shape", () => {
    const cons: SketchConstraint[] = [{ type: "p2lDistance", e: "c1", p: 0, line: "r1~2", value: 6, id: "k3" }];
    expect(extras(cons)).toMatchObject([{ name: "Distance to line between Circle 1 and Rectangle 1 edge 3" }]);
  });

  it("never mixes two documents' subjects", () => {
    const first = extras([{ type: "angle", l1: "l1", l2: "l2", value: 70, id: "a" }]);
    const second = extras(
      [{ type: "angle", l1: "m1", l2: "m2", value: 20, id: "b" }],
      [line("m1", 2, 2, 9, 4), line("m2", 9, 4, 3, 8)],
    );
    expect(first.map((g) => g.key)).toEqual(["c:a"]);
    expect(second.map((g) => [g.key, g.entities])).toEqual([["c:b", ["m1", "m2"]]]);
  });
});
