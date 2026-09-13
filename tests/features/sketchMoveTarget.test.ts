import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  applySketchMove,
  planeAfter,
  sketchEntityTarget,
  similarityIn,
  transformEntity,
} from "../../src/features/sketchMoveTarget";
import { composeMove, moveMatrix, scaleAbout } from "../../src/features/transformGizmo";
import { freshIds } from "../../src/features/moveTarget";
import { SketchPlane } from "../../src/sketch/plane";
import type { CadDocument, Feature } from "../../src/types";

const deg = (d: number) => (d * Math.PI) / 180;

function gizmoMatrix(pivot: THREE.Vector3, axis: THREE.Vector3, turnDeg: number, t: THREE.Vector3, s = 1) {
  const rot = new THREE.Quaternion().setFromAxisAngle(axis, deg(turnDeg));
  return moveMatrix(composeMove(pivot, rot, t)).multiply(scaleAbout(pivot, new THREE.Vector3(s, s, s)));
}

describe("planeAfter", () => {
  it("lifts an XY sketch by dz", () => {
    const m = new THREE.Matrix4().makeTranslation(0, 0, 12);
    expect(planeAfter("XY", m)).toEqual({ origin: [0, 0, 12], normal: [0, 0, 1], xdir: [1, 0, 0] });
  });

  it("stands an XY sketch up on XZ when turned 90 degrees about X", () => {
    const m = gizmoMatrix(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), 90, new THREE.Vector3());
    expect(planeAfter("XY", m)).toEqual({ origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] });
  });

  it("carries the pivot correction onto the origin", () => {
    // turning about (10,0,0) by 180 about Z swings the origin to (20,0,0)
    const m = gizmoMatrix(new THREE.Vector3(10, 0, 0), new THREE.Vector3(0, 0, 1), 180, new THREE.Vector3());
    const p = planeAfter("XY", m);
    expect(p.origin).toEqual([20, 0, 0]);
    expect(p.xdir).toEqual([-1, 0, 0]);
  });
});

describe("similarityIn", () => {
  it("reads a turn, a slide and a resize in the plane's own coordinates", () => {
    const plane = new SketchPlane("XZ"); // u = X, v = Z
    const m = gizmoMatrix(new THREE.Vector3(5, 0, 5), plane.n, 90, new THREE.Vector3(3, 0, 0), 2);
    const sim = similarityIn(plane, m);
    expect(sim.f).toBeCloseTo(2, 9);
    // every sketch point maps where the world matrix sends it
    for (const [x, y] of [[0, 0], [10, 0], [4, -7]] as const) {
      const world = plane.to3D(x, y).applyMatrix4(m);
      const c = Math.cos(sim.angle), s = Math.sin(sim.angle);
      const px = sim.f * (x * c - y * s) + sim.tx;
      const py = sim.f * (x * s + y * c) + sim.ty;
      const want = plane.to2D(world);
      expect(px).toBeCloseTo(want.x, 9);
      expect(py).toBeCloseTo(want.y, 9);
    }
  });
});

describe("transformEntity", () => {
  it("keeps a rectangle a rectangle when it only slides", () => {
    const rect = { type: "rectangle", id: "r", x: 0, y: 0, width: 4, height: 2 } as const;
    const out = transformEntity(rect, { f: 1, angle: 0, tx: 5, ty: -1 }, "r");
    expect(out).toEqual([{ type: "rectangle", id: "r", x: 5, y: -1, width: 4, height: 2 }]);
  });

  it("resizes, turns, then slides a line", () => {
    const line = { type: "line", id: "l", x1: 1, y1: 0, x2: 2, y2: 0 } as const;
    const [out] = transformEntity(line, { f: 2, angle: Math.PI / 2, tx: 10, ty: 0 }, "l");
    expect(out?.type).toBe("line");
    if (out?.type !== "line") return;
    expect(out.x1).toBeCloseTo(10, 9);
    expect(out.y1).toBeCloseTo(2, 9);
    expect(out.x2).toBeCloseTo(10, 9);
    expect(out.y2).toBeCloseTo(4, 9);
  });
});

describe("applySketchMove", () => {
  const doc = (): CadDocument => ({
    features: [
      { id: "s1", type: "sketch", plane: "XY", face: { kind: "face" } as never, at: [0, 0, 0], entities: [] },
      { id: "e1", type: "extrude", sketch: "s1", distance: 5, operation: "new", regions: [[1, 2, 0]] },
      { id: "e2", type: "extrude", sketch: "other", distance: 5, operation: "new", regions: [[1, 2, 0]] },
      { id: "lo", type: "loft", profiles: [{ sketch: "s1", region: [0, 0, 0] }, { sketch: "other", region: [0, 0, 9] }] },
    ] as Feature[],
    parameters: {},
  }) as unknown as CadDocument;

  it("rewrites the plane, drops the face link, and moves the profile picks on it", () => {
    const d = doc();
    const m = new THREE.Matrix4().makeTranslation(0, 0, 7);
    const detached = applySketchMove(d, ["s1"], {}, m);
    expect(detached).toEqual(["s1"]);
    const [s1, e1, e2, lo] = d.features as any[];
    expect(s1.plane).toEqual({ origin: [0, 0, 7], normal: [0, 0, 1], xdir: [1, 0, 0] });
    expect(s1.face).toBeUndefined();
    expect(s1.at).toBeUndefined();
    expect(e1.regions).toEqual([[1, 2, 7]]);
    expect(e2.regions).toEqual([[1, 2, 0]]);
    expect(lo.profiles).toEqual([{ sketch: "s1", region: [0, 0, 7] }, { sketch: "other", region: [0, 0, 9] }]);
  });

  it("starts from the plane the build resolved, not the cached one", () => {
    const d = doc();
    const resolved = { sketchPlanes: { s1: { origin: [0, 0, 3], normal: [0, 0, 1], xdir: [1, 0, 0] } as never } };
    applySketchMove(d, ["s1"], resolved, new THREE.Matrix4().makeTranslation(1, 0, 0));
    expect((d.features[0] as any).plane.origin).toEqual([1, 0, 3]);
  });
});

describe("sketchEntityTarget", () => {
  it("centres a text on its letters rather than on its anchor", () => {
    const text = { type: "text" as const, id: "t", text: "TEXT", x: 0, y: 0, height: 10, angle: 0 };
    const target = sketchEntityTarget({
      plane: () => new SketchPlane("XY"),
      selection: () => [text],
      showPreview: () => {},
      apply: () => {},
      outline: () => [new THREE.Vector2(0, 0), new THREE.Vector2(40, 0), new THREE.Vector2(40, 10), new THREE.Vector2(0, 10)],
    });
    expect(target!.centroid().toArray()).toEqual([20, 5, 0]);
  });
});

describe("freshIds", () => {
  it("hands out distinct ids that are not in the document", () => {
    const store = { document: { features: [{ id: "f1" }, { id: "f3" }] } } as never;
    const ids = freshIds(store, 2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain("f1");
    expect(ids).not.toContain("f3");
  });
});
