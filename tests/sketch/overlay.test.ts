// Rendering contract for projected (linked) reference geometry: the ONE
// curveObjects factory feeds BOTH display paths, the open sketch's active
// curves and the committed model overlay, so asserting its material colors
// here covers stale/link rendering end to end (the stale FLAG's propagation
// into doc entities is covered by the step-4 refresh e2e).
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { curveObjects } from "../../src/sketch/overlay";
import { SketchPlane } from "../../src/sketch/plane";
import type { ResolvedEntity } from "../../src/sketch/snap";

const PROJECTED_COLOR = 0xb07fe8; // purple link color (overlay.ts)
const PROJECTED_STALE_COLOR = 0xd9a24d; // amber: source no longer resolves

const SRC = { kind: "sketchCurve", sketch: "s0", entity: "e0" } as const;
const matColor = (o: THREE.Object3D): number => {
  // one object per entity; circles/arcs are a group of curve + center marker
  const line = (o as THREE.Group).isGroup ? (o as THREE.Group).children[0] : o;
  return ((line as THREE.Line).material as THREE.LineBasicMaterial).color.getHex();
};

describe("curveObjects, projected link colors", () => {
  const plane = new SketchPlane("XY");
  const fresh: ResolvedEntity = {
    type: "projected",
    id: "p1",
    source: SRC,
    curve: { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
  };
  const stale: ResolvedEntity = { ...fresh, id: "p2", stale: true };

  it("fresh projected renders purple, stale renders amber, regardless of pass color", () => {
    const objs = curveObjects([fresh, stale], plane, 0xffffff);
    expect(objs).toHaveLength(2);
    expect(matColor(objs[0]!)).toBe(PROJECTED_COLOR);
    expect(matColor(objs[1]!)).toBe(PROJECTED_STALE_COLOR);
  });

  it("selection/hover emphasis (highlight) is preferred over the link color", () => {
    const objs = curveObjects([stale], plane, 0x33aaff, true);
    expect(matColor(objs[0]!)).toBe(0x33aaff);
  });

  it("a broken (now native) line renders in the pass color again", () => {
    const native: ResolvedEntity = { type: "line", id: "p1", x1: 0, y1: 0, x2: 10, y2: 0 };
    const objs = curveObjects([native], plane, 0xffffff);
    expect(matColor(objs[0]!)).toBe(0xffffff);
  });
});

describe("curveObjects, construction geometry", () => {
  const plane = new SketchPlane("XZ");
  const ax: ResolvedEntity = { type: "line", id: "ax", x1: 3.5, y1: -2, x2: 9.5, y2: 6.25, construction: true };
  const arc: ResolvedEntity = {
    type: "arc",
    id: "a1",
    x1: 20,
    y1: 1,
    x2: 24,
    y2: 5,
    mx: 23.5,
    my: 2.5,
    construction: true,
  };
  const dashed = (o: THREE.Object3D) => {
    const line = (o as THREE.Group).isGroup ? (o as THREE.Group).children[0] : o;
    return (line as THREE.Line).material instanceof THREE.LineDashedMaterial;
  };

  it("keeps its dashed orange on a plain pass", () => {
    const objs = curveObjects([ax, arc], plane, 0x5b9bff);
    expect(objs.map((o) => [matColor(o), dashed(o)])).toEqual([
      [0xffa64d, true],
      [0xffa64d, true],
    ]);
  });

  it("is drawn dashed in the asked colour on a highlight pass, one material per colour", () => {
    const blue = curveObjects([ax, arc], plane, 0x33aaff, true);
    const red = curveObjects([ax], plane, 0xff5555, true);
    expect(blue.map((o) => [matColor(o), dashed(o)])).toEqual([
      [0x33aaff, true],
      [0x33aaff, true],
    ]);
    expect([matColor(red[0]!), dashed(red[0]!)]).toEqual([0xff5555, true]);
    expect((blue[0] as THREE.Line).material).toBe(((blue[1] as THREE.Group).children[0] as THREE.Line).material);
  });
});
