import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildStressMesh } from "../../src/viewport/overlays";

function strip(vertices: number) {
  const positions = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) positions.set([13.5 + v * 0.01, -7.25 + (v % 2) * 0.5, 4.1 + v * 0.002], v * 3);
  const indices: number[] = [];
  for (let v = 0; v + 2 < vertices; v++) indices.push(v, v + 1, v + 2);
  return { positions, indices, colors: new Float32Array(vertices * 3).fill(0.5) };
}

describe("buildStressMesh", () => {
  it("uses a drawn surface's Uint32 index as it is, past 65 535 vertices, without a copy", () => {
    const s = strip(70_001);
    const indices = Uint32Array.from(s.indices);
    const mesh = buildStressMesh(s.positions, indices, s.colors);
    const index = mesh.geometry.getIndex()!;
    expect(index.array).toBe(indices);
    expect({ array: index.array.constructor, count: index.count, last: index.getX(index.count - 1) }).toEqual({
      array: Uint32Array,
      count: s.indices.length,
      last: 70_000,
    });
    expect(mesh.geometry.getAttribute("position").count).toBe(70_001);
  });

  it("takes a plain index array as before", () => {
    const s = strip(4);
    const mesh = buildStressMesh(Array.from(s.positions), s.indices, s.colors);
    expect(Array.from(mesh.geometry.getIndex()!.array)).toEqual([0, 1, 2, 1, 2, 3]);
    expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
  });
});
