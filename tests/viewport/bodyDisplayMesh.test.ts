import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Viewport } from "../../src/viewport/viewport";

// Two bodies, the second moved and turned by its mesh transform, as a gizmo drag leaves it.
function withBodies() {
  const v = Object.create(Viewport.prototype) as Viewport;
  const body = (id: string, faceStart: number, faceIds: number[], positions: number[], index: number[]) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(index);
    return { id, faceStart, faceIds, mesh: new THREE.Mesh(geometry) };
  };
  const a = body("a", 0, [0], [1.5, -2, 3, 4, -2, 3, 1.5, 7, 3.25], [0, 1, 2]);
  const b = body("b", 3, [3, 5], [0, 0, 0, 2, 0, 0, 0, 3, 0, 2, 3, 1], [0, 1, 2, 1, 3, 2]);
  b.mesh.position.set(10, -4, 2.5);
  b.mesh.rotation.z = Math.PI / 2;
  (v as unknown as { model: unknown }).model = { bodies: [a, b] };
  return v;
}

const rounded = (x: Float32Array) => Array.from(x, (n) => Math.round(n * 1e5) / 1e5 + 0);

describe("bodyDisplayMesh", () => {
  it("copies one body's display mesh in world space with its global face ids", () => {
    const v = withBodies();
    const m = v.bodyDisplayMesh("b")!;
    expect({ ...m, positions: rounded(m.positions) }).toEqual({
      positions: [10, -4, 2.5, 10, -2, 2.5, 7, -4, 2.5, 7, -2, 3.5],
      indices: Uint32Array.from([0, 1, 2, 1, 3, 2]),
      faceIds: Int32Array.from([3, 5]),
      faceStart: 3,
    });
    const a = v.bodyDisplayMesh("a")!;
    expect({ ...a, positions: rounded(a.positions) }).toEqual({
      positions: [1.5, -2, 3, 4, -2, 3, 1.5, 7, 3.25],
      indices: Uint32Array.from([0, 1, 2]),
      faceIds: Int32Array.from([0]),
      faceStart: 0,
    });
  });

  it("is null for a body that is not on the model, or with no model", () => {
    expect(withBodies().bodyDisplayMesh("c")).toBeNull();
    expect((Object.create(Viewport.prototype) as Viewport).bodyDisplayMesh("a")).toBeNull();
  });
});
