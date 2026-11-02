// A box of six faces with real wires, for a Viewport with a real Highlighter.
import * as THREE from "three";
import { BodyEdges } from "../../src/viewport/edgeLines";
import type { BodyMesh } from "../../src/viewport/render";

type P3 = [number, number, number];

export function bodyMesh(id: string, faceStart: number, edges: { id: string; points: P3[] }[]): BodyMesh {
  const geometry = new THREE.BoxGeometry(17, 9, 23);
  const n = geometry.getAttribute("position").count;
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.position.set(41, -13, 7);
  const tris = geometry.getIndex()!.count / 3;
  const faceIds = Array.from({ length: tris }, (_, t) => faceStart + Math.floor(t / 2));
  const faceTriangles = new Map<number, number[]>();
  faceIds.forEach((f, t) => faceTriangles.set(f, [...(faceTriangles.get(f) ?? []), t]));
  return {
    id,
    name: id,
    faceStart,
    faceCount: 6,
    mesh,
    faceIds,
    baseColors: new Float32Array(n * 3),
    faceTriangles,
    edges: new BodyEdges(edges.map((e) => ({ ...e, body: id })) as never, new THREE.Vector2(800, 600)),
  } as unknown as BodyMesh;
}
