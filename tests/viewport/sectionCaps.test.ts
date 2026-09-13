import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildBodyMesh } from "../../src/viewport/render";
import { CAP_BODY_LIMIT, SectionCaps } from "../../src/viewport/sectionCaps";
import type { RebuildResult } from "../../src/types";

function cube(id: string, faceStart: number): RebuildResult {
  const positions = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10];
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return {
    mesh: { positions, indices, faceIds: indices.filter((_, i) => i % 3 === 0).map((_, i) => faceStart + Math.floor(i / 2)) },
    edges: [],
    bbox: { min: [0, 0, 0], max: [10, 10, 10] },
    bodies: [{ id, name: id, faceStart, faceCount: 6 }],
  };
}

const bodyOf = (id: string) => {
  const r = cube(id, 0);
  return buildBodyMesh(r, r.bodies![0]!, [], new THREE.Vector2(800, 600), undefined);
};

const PLANE = new THREE.Plane(new THREE.Vector3(0, 0, -1), 4);

describe("SectionCaps", () => {
  it("counts each body's back and front faces through the cut, then paints a cap on the plane", () => {
    const caps = new SectionCaps();
    const bodies = [bodyOf("a"), bodyOf("b")];
    caps.mount(bodies, PLANE, () => new THREE.Color(0x9aa7b4));
    const passes = bodies.flatMap((b) => b.mesh.children as THREE.Mesh[]);
    expect(passes.map((m) => (m.material as THREE.Material).side)).toEqual([
      THREE.BackSide, THREE.FrontSide, THREE.BackSide, THREE.FrontSide,
    ]);
    for (const m of passes) {
      const mat = m.material as THREE.MeshBasicMaterial;
      expect(mat.colorWrite).toBe(false);
      expect(mat.clippingPlanes).toEqual([PLANE]);
    }
    const quads = caps.group.children as THREE.Mesh[];
    expect(quads).toHaveLength(2);
    expect(quads[0]!.renderOrder).toBeGreaterThan(passes[1]!.renderOrder);
    expect(passes[2]!.renderOrder).toBeGreaterThan(quads[0]!.renderOrder);
    expect(PLANE.distanceToPoint(quads[0]!.position)).toBeCloseTo(0);
  });

  it("follows the plane without a remount", () => {
    const caps = new SectionCaps();
    caps.mount([bodyOf("a")], PLANE, () => new THREE.Color());
    const moved = new THREE.Plane(new THREE.Vector3(0, 0, -1), 7);
    caps.place(moved);
    expect(moved.distanceToPoint((caps.group.children[0] as THREE.Mesh).position)).toBeCloseTo(0);
  });

  it("takes everything back off the bodies", () => {
    const caps = new SectionCaps();
    const body = bodyOf("a");
    caps.mount([body], PLANE, () => new THREE.Color());
    caps.clear();
    expect(body.mesh.children).toHaveLength(0);
    expect(caps.group.children).toHaveLength(0);
  });

  it("leaves a very large assembly uncapped", () => {
    const caps = new SectionCaps();
    const body = bodyOf("a");
    caps.mount(Array.from({ length: CAP_BODY_LIMIT + 1 }, () => body), PLANE, () => new THREE.Color());
    expect(caps.group.children).toHaveLength(0);
    expect(body.mesh.children).toHaveLength(0);
  });
});
