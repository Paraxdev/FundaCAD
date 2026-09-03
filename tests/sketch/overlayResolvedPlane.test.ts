// A sketch that follows a body face is drawn where the BUILD put it.
//
// The sketch's own `plane` is the cache written when the pick was made. Once the
// sketch follows a face, that cache and the plane the sidecar actually built on
// part company the moment anything upstream moves — and the overlay is the half
// the user sees. Drawing the cache means the profile outline sits at the old
// height while the pocket cut from it sits at the new one: one model, two
// answers, and nothing on screen saying which is which.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { SketchOverlay } from "../../src/sketch/overlay";
import type { CadDocument, PlaneDef } from "../../src/types";

const CACHED: PlaneDef = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };
const MOVED: PlaneDef = { origin: [0, 0, 25], normal: [0, 0, 1], xdir: [1, 0, 0] };

const doc = (extra: Record<string, unknown> = {}): CadDocument =>
  ({
    version: 9,
    parameters: {},
    features: [
      {
        id: "s1", type: "sketch", plane: CACHED, ...extra,
        entities: [{ type: "rectangle", id: "a", x: 0, y: 0, width: 10, height: 10 }],
      },
    ],
  }) as unknown as CadDocument;

/** Every z the overlay actually drew a curve vertex at. */
const drawnZ = (o: SketchOverlay) => {
  const zs = new Set<number>();
  // `committed` is the overlay's own group of drawn curves and is private; this
  // reads it rather than widening the class, since what is under test is where
  // the curves LANDED and there is no other way to ask.
  const committed = (o as unknown as { committed: THREE.Object3D }).committed;
  committed.traverse((obj) => {
    const g = (obj as { geometry?: { getAttribute?: (n: string) => unknown } }).geometry;
    const pos = g?.getAttribute?.("position") as
      | { count: number; getZ: (i: number) => number }
      | undefined;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) zs.add(Math.round(pos.getZ(i) * 1e6) / 1e6);
  });
  return [...zs].sort((a, b) => a - b);
};

describe("SketchOverlay.resolvedPlanes", () => {
  it("draws at the feature's own plane when the build reported nothing", () => {
    // The control. Every document with no face anchor takes this path, and it
    // must draw exactly where it always did.
    const o = new SketchOverlay();
    o.update(doc());
    expect(drawnZ(o)).toEqual([10]);
  });

  it("draws at the plane the build used when the sketch followed its face", () => {
    const o = new SketchOverlay();
    o.resolvedPlanes = () => ({ sketchPlanes: { s1: MOVED } });
    o.update(doc());
    expect(drawnZ(o)).toEqual([25]);
  });

  it("follows the datum a sketch is bound to", () => {
    // A sketch made by "Offset plane" has no anchor of its own: the datum holds
    // it, and the sidecar builds the sketch through that link. Without this the
    // geometry follows and only the drawing stays behind.
    const o = new SketchOverlay();
    o.resolvedPlanes = () => ({ datumPlanes: { d1: MOVED } });
    o.update(doc({ planeId: "d1" }));
    expect(drawnZ(o)).toEqual([25]);
  });

  it("leaves a sketch alone when the report is about some other feature", () => {
    const o = new SketchOverlay();
    o.resolvedPlanes = () => ({ sketchPlanes: { s2: MOVED }, datumPlanes: { d9: MOVED } });
    o.update(doc({ planeId: "d1" }));
    expect(drawnZ(o)).toEqual([10]);
  });

  it("re-reads the report on every update rather than caching the first", () => {
    // update() runs after every rebuild, and the whole point is that the answer
    // changes between them.
    const o = new SketchOverlay();
    let planes: Record<string, PlaneDef> = {};
    o.resolvedPlanes = () => ({ sketchPlanes: planes });
    o.update(doc());
    expect(drawnZ(o)).toEqual([10]);
    planes = { s1: MOVED };
    o.update(doc());
    expect(drawnZ(o)).toEqual([25]);
  });
});
