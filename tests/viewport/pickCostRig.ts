// A synthetic body for the pick cost tests: `faces` unit squares in a row, each tessellated into `trisPerFace`
// triangles with vertices of its own, and an edge between each pair of neighbours.
import * as THREE from "three";
import { BodyEdges } from "../../src/viewport/edgeLines";
import type { BodyMesh, ModelView } from "../../src/viewport/render";

export function costRig(faces: number, trisPerFace: number) {
  const tris = faces * trisPerFace;
  const pos = new Float32Array(tris * 9);
  const faceIds: number[] = new Array(tris);
  const faceTriangles = new Map<number, number[]>();
  let t = 0;
  for (let f = 0; f < faces; f++) {
    const list: number[] = [];
    for (let k = 0; k < trisPerFace; k++, t++) {
      // the first two triangles span the square, the rest are slivers inside it
      const quad =
        k === 0
          ? [f, 0, f + 1, 0, f + 1, 1]
          : k === 1
            ? [f, 0, f + 1, 1, f, 1]
            : [f + 0.2, 0.2 + k * 0.001, f + 0.8, 0.2 + k * 0.001, f + 0.5, 0.8];
      for (let v = 0; v < 3; v++) {
        pos[t * 9 + v * 3] = quad[v * 2]!;
        pos[t * 9 + v * 3 + 1] = quad[v * 2 + 1]!;
        pos[t * 9 + v * 3 + 2] = 0;
      }
      faceIds[t] = f;
      list.push(t);
    }
    faceTriangles.set(f, list);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(
    new THREE.BufferAttribute(
      Uint32Array.from({ length: tris * 3 }, (_, i) => i),
      1,
    ),
  );
  const colors = new Float32Array(tris * 9).fill(0.5);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors.slice(), 3));
  const mesh = new THREE.Mesh(geometry);
  const edgeList = Array.from({ length: faces - 1 }, (_, i) => ({
    id: `e${i}`,
    body: "b1",
    points: [
      [i + 1, 0, 0],
      [i + 1, 1, 0],
    ],
  }));
  const draw = new BodyEdges(edgeList as never, new THREE.Vector2(800, 600));
  const body = {
    id: "b1",
    faceStart: 0,
    faceCount: faces,
    mesh,
    faceIds,
    faceTriangles,
    baseColors: colors,
    edges: draw,
  } as unknown as BodyMesh;
  return { view: { bodies: [body] } as unknown as ModelView, draw, mesh };
}
