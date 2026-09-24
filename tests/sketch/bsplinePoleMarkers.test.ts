// A control-point spline that is not selected hides its control polygon, but a
// pole a dimension or constraint holds is still drawn, so the dimension's
// witness line ends at something visible.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { constrainedPoles, type BsplineEntity } from "../../src/sketch/bsplineEdit";
import { poleRef } from "../../src/sketch/bspline";
import { controlPolygonObjects, poleMarkerObjects } from "../../src/sketch/overlay";
import { SketchPlane } from "../../src/sketch/plane";
import type { SketchConstraint } from "../../src/types";

const b: BsplineEntity = {
  type: "bspline", id: "b",
  poles: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 25, y: -10 }, { x: 40, y: 15 }, { x: 50, y: 0 }],
};
const n = b.poles.length;

/** Centres of the squares a LineSegments of pole squares draws. */
function squareCentres(o: THREE.Object3D): THREE.Vector3[] {
  const pos = ((o as THREE.LineSegments).geometry.getAttribute("position") as THREE.BufferAttribute);
  const out: THREE.Vector3[] = [];
  for (let s = 0; s < pos.count / 8; s++) {
    const c = new THREE.Vector3();
    for (let i = 0; i < 8; i++) c.add(new THREE.Vector3().fromBufferAttribute(pos, s * 8 + i));
    out.push(c.divideScalar(8));
  }
  return out;
}

describe("poles a constraint holds", () => {
  it("are the ones any point constraint or dimension names, and only this spline's", () => {
    const cons: SketchConstraint[] = [
      { type: "p2pDistance", e1: "b", p1: poleRef(2, n), e2: "l", p2: 0, value: 12 },
      { type: "p2lDistance", e: "b", p: poleRef(3, n), line: "l", value: 4 },
      { type: "fix", e: "b", p: poleRef(0, n) },
      { type: "coincident", e1: "l", p1: 1, e2: "b", p2: poleRef(2, n) },
      { type: "fix", e: "other", p: poleRef(1, n) },
      { type: "horizontal", line: "l" },
    ];
    expect(constrainedPoles(cons, "b", n)).toEqual([0, 2, 3]);
    expect(constrainedPoles([], "b", n)).toEqual([]);
  });

  it("are drawn as squares on exactly those poles, without the polygon", () => {
    const plane = new SketchPlane("XY");
    const o = poleMarkerObjects(b, plane, 0.1, [1, 3]);
    expect((o as THREE.LineSegments).isLineSegments).toBe(true);
    const centres = squareCentres(o);
    expect(centres).toHaveLength(2);
    for (const [i, k] of [1, 3].entries()) {
      const want = plane.to3D(b.poles[k]!.x, b.poles[k]!.y);
      expect(centres[i]!.distanceTo(want)).toBeLessThan(1e-9);
    }
  });

  it("while a selected spline still shows its polygon and every pole", () => {
    const g = controlPolygonObjects(b, new SketchPlane("XY"), 0.1);
    const squares = g.children.find((c) => (c as THREE.LineSegments).isLineSegments)!;
    expect(squareCentres(squares)).toHaveLength(n);
    expect(g.children.some((c) => (c as THREE.Line).isLine && !(c as THREE.LineSegments).isLineSegments)).toBe(true);
  });
});
