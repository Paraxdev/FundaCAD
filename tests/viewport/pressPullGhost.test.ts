// The press/pull cap ghost on curved faces: a sphere grows about its centre,
// a cone or a torus is offset along its own normals.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GhostLayer } from "../../src/viewport/ghosts";
import type { BodyEdges, BodyMesh, ModelView } from "../../src/viewport/render";
import type { RoundFace } from "../../src/features/radialDrag";

/** One face, faceId 0, from triangles given corner by corner. */
function layer(tris: THREE.Vector3[][], normals?: (p: THREE.Vector3) => THREE.Vector3) {
  const positions = tris.flat().flatMap((p) => p.toArray());
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (normals) geo.setAttribute("normal", new THREE.Float32BufferAttribute(tris.flat().flatMap((p) => normals(p).toArray()), 3));
  geo.setIndex(Array.from({ length: tris.length * 3 }, (_, i) => i));
  const body: BodyMesh = {
    id: "b", name: "b", faceStart: 0, faceCount: 1,
    mesh: new THREE.Mesh(geo),
    faceIds: tris.map(() => 0),
    edges: {} as BodyEdges,
    baseColors: new Float32Array(0),
    faceTriangles: new Map([[0, tris.map((_, i) => i)]]),
  };
  const model: ModelView = { bodies: [body], edges: [], orphanEdges: null, box: new THREE.Box3() };
  const added: THREE.Object3D[] = [];
  const ghosts = new GhostLayer({
    model: () => model,
    addToScene: (o) => added.push(o),
    removeFromScene: () => {},
    requestRender: () => {},
    faceNormalWorld: () => new THREE.Vector3(0, 0, 1),
  });
  const cap = () => {
    const m = added.at(-1) as THREE.Mesh | undefined;
    const pos = m?.geometry.getAttribute("position");
    return pos ? Array.from({ length: pos.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(pos, i)) : [];
  };
  return { ghosts, cap };
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe("press/pull ghost on curved faces", () => {
  it("grows a sphere patch about its centre", () => {
    // An octant of a ball of radius 5 about (1, 2, 3), as two facets.
    const c = V(1, 2, 3);
    const on = (x: number, y: number, z: number) => V(x, y, z).normalize().multiplyScalar(5).add(c);
    const { ghosts, cap } = layer([[on(1, 0, 0), on(0, 1, 0), on(1, 1, 1)], [on(0, 1, 0), on(0, 0, 1), on(1, 1, 1)]]);
    const ball: RoundFace = {
      cylinder: { axis: [0, 0, 1], point: [1, 2, 3], radius: 5 },
      radius: 5, solidInside: true, radial: V(1, 0, 0), full: false, centre: [1, 2, 3],
    };
    ghosts.setPressPullGhost([0], 1.5, ball);
    const pts = cap();
    expect(pts).toHaveLength(6);
    for (const p of pts) expect(p.distanceTo(c)).toBeCloseTo(6.5, 5);
  });

  it("offsets a cone patch along its own normals", () => {
    // Two facets of a cone round Z, apex up, normals tilted 45 degrees.
    const on = (a: number, z: number) => V((4 - z) * Math.cos(a), (4 - z) * Math.sin(a), z);
    const normal = (p: THREE.Vector3) => V(p.x, p.y, 0).normalize().add(V(0, 0, 1)).normalize();
    const { ghosts, cap } = layer([[on(0, 0), on(0.4, 0), on(0, 2)], [on(0.4, 0), on(0.4, 2), on(0, 2)]], normal);
    ghosts.setPressPullGhost([0], -0.5, "normal");
    const pts = cap();
    expect(pts).toHaveLength(6);
    const src = [on(0, 0), on(0.4, 0), on(0, 2), on(0.4, 0), on(0.4, 2), on(0, 2)];
    pts.forEach((p, i) => {
      const want = src[i]!.clone().addScaledVector(normal(src[i]!), -0.5);
      expect(p.distanceTo(want)).toBeLessThan(1e-5);
    });
  });
});
