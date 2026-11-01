import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Viewport } from "../../src/viewport/viewport";

// Two bodies whose faces touch along x = 10, the first in the model's order owns face 1.
function touching() {
  const v = Object.create(Viewport.prototype) as Viewport;
  const body = (id: string, faceId: number) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([10, 0, 0, 10, 5, 0, 10, 0, 5], 3));
    geometry.setIndex([0, 1, 2]);
    return { id, faceTriangles: new Map([[faceId, [0]]]), mesh: new THREE.Mesh(geometry) };
  };
  const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(20, 5, 5));
  Object.assign(v, { model: { bodies: [body("body1", 1), body("body2", 2)], box }, projScratch: new THREE.Vector3() });
  return v;
}

describe("faceIdNear", () => {
  const onBoth: [number, number, number] = [10, 1, 1];

  it("answers from every body when no body is named", () => {
    expect(touching().faceIdNear(onBoth)).toBe(1);
  });

  it("answers only from the body named", () => {
    expect(touching().faceIdNear(onBoth, 0, "body2")).toBe(2);
  });

  it("finds nothing on a body the model does not have", () => {
    expect(touching().faceIdNear(onBoth, 0, "body3")).toBeNull();
  });
});
