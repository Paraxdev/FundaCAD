import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Viewport } from "../../src/viewport/viewport";
import { faceNearStats } from "../../src/viewport/faceNear";
import { midMatchTol } from "../../src/viewport/edgeMatch";
import type { BodyMesh } from "../../src/viewport/render";

type P3 = [number, number, number];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const N = 40;
const height = (x: number, y: number) => (x > 24 ? 0 : Math.round(3 * Math.sin(x / 5) * Math.cos(y / 7)));

/** An N by N lattice heightfield, flat where x > 24 so neighbouring faces tie there. The lower left 20 by 20 cells are
 *  one face of 800 triangles, the rest 5 by 5 tiles, inserted into faceTriangles in a shuffled order. */
function lattice(id: string, seed: number, faceBase: number, at?: THREE.Vector3): BodyMesh {
  const pos: number[] = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) pos.push(i, j, height(i, j));
  const idx: number[] = [];
  const faceOfTri: number[] = [];
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      const face = i < 20 && j < 20 ? 0 : 1 + Math.floor(j / 5) * 8 + Math.floor(i / 5);
      idx.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
      faceOfTri.push(face, face);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setIndex(idx);
  const lists = new Map<number, number[]>();
  faceOfTri.forEach((f, t) => {
    let l = lists.get(f);
    if (!l) lists.set(f, (l = []));
    l.push(t);
  });
  const r = rng(seed);
  const keys = [...lists.keys()].sort(() => r() - 0.5);
  const faceTriangles = new Map(keys.map((k) => [faceBase + k, lists.get(k)!]));
  const mesh = new THREE.Mesh(geometry);
  if (at) mesh.position.copy(at);
  mesh.updateMatrixWorld(true);
  return { id, name: id, mesh, faceTriangles } as unknown as BodyMesh;
}

function viewportOf(bodies: BodyMesh[]) {
  const v = Object.create(Viewport.prototype) as Viewport;
  const box = new THREE.Box3();
  for (const b of bodies) box.expandByObject(b.mesh);
  Object.assign(v, { model: { bodies, box }, projScratch: new THREE.Vector3() });
  return v;
}

/** The lookup as it was before the prefilter: every triangle, the first strictly nearer one wins. */
function fullScan(bodies: BodyMesh[], point: P3, tol: number, onBody?: string): number | null {
  const target = new THREE.Vector3(...point);
  const local = new THREE.Vector3();
  const tri = new THREE.Triangle();
  const closest = new THREE.Vector3();
  let best: number | null = null;
  let bestDist = Infinity;
  for (const body of bodies) {
    if (onBody !== undefined && body.id !== onBody) continue;
    local.copy(target).applyMatrix4(body.mesh.matrixWorld.clone().invert());
    const pos = body.mesh.geometry.getAttribute("position");
    const index = body.mesh.geometry.getIndex()!;
    for (const [faceId, tris] of body.faceTriangles)
      for (const t of tris) {
        tri.a.fromBufferAttribute(pos, index.getX(t * 3));
        tri.b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
        tri.c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
        tri.closestPointToPoint(local, closest);
        const d = closest.distanceTo(local);
        if (d < bestDist) {
          bestDist = d;
          best = faceId;
        }
      }
  }
  return best != null && bestDist <= tol ? best : null;
}

function probes(seed: number, count: number): P3[] {
  const r = rng(seed);
  const out: P3[] = [];
  for (let k = 0; k < count; k++) {
    const kind = k % 4;
    const i = Math.floor(r() * (N + 1)),
      j = Math.floor(r() * (N + 1));
    if (kind === 0) out.push([i, j, height(i, j)]);
    else if (kind === 1) out.push([i + 0.5, j, height(i, j) + (r() < 0.5 ? 0 : 1.25)]);
    else if (kind === 2) out.push([5 * Math.round(i / 5), 5 * Math.round(j / 5), r() * 2]);
    else out.push([r() * (N + 10) - 5, r() * (N + 10) - 5, r() * 12 - 6]);
  }
  return out;
}

describe("faceIdNear with the cluster prefilter", () => {
  it("answers exactly as a scan of every triangle, on corners, shared edges and off the mesh", () => {
    const bodies = [lattice("body1", 1, 0), lattice("body2", 2, 1000, new THREE.Vector3(20, 0, 0))];
    const v = viewportOf(bodies);
    const box = new THREE.Box3();
    for (const b of bodies) box.expandByObject(b.mesh);
    const tol = midMatchTol(box.getSize(new THREE.Vector3()).length());
    const pts = probes(7, 600);
    let ties = 0;
    for (const p of pts) {
      for (const extra of [0, 1e6]) {
        expect(v.faceIdNear(p, extra)).toBe(fullScan(bodies, p, tol + extra));
        expect(v.faceIdNear(p, extra, "body2")).toBe(fullScan(bodies, p, tol + extra, "body2"));
      }
      if (p[0] >= 25 && p[0] <= 40 && Number.isInteger(p[0]) && p[0] % 5 === 0) ties++;
    }
    expect(ties).toBeGreaterThan(10);
  });

  it("touches a small share of the mesh for a point on one small face", () => {
    const body = lattice("body1", 3, 0);
    const v = viewportOf([body]);
    v.faceIdNear([32.3, 32.6, 0]);
    faceNearStats.triangles = 0;
    expect(v.faceIdNear([32.3, 32.6, 0])).toBe(fullScan([body], [32.3, 32.6, 0], 0.5));
    expect(faceNearStats.triangles).toBeGreaterThan(0);
    expect(faceNearStats.triangles).toBeLessThan((2 * N * N) / 10);
  });

  it("follows a new mesh and moved vertices, never an index of the old ones", () => {
    const body = lattice("body1", 4, 0);
    const v = viewportOf([body]);
    const p: P3 = [32.3, 32.6, 0];
    const before = v.faceIdNear(p);
    expect(before).not.toBeNull();

    const pos = body.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) pos.setZ(k, pos.getZ(k) + 50);
    pos.needsUpdate = true;
    expect(v.faceIdNear(p)).toBe(fullScan([body], p, 0.5));
    expect(v.faceIdNear([32.3, 32.6, 50])).toBe(before);

    const next = lattice("body1", 5, 500);
    body.mesh.geometry = next.mesh.geometry;
    body.faceTriangles = next.faceTriangles;
    expect(v.faceIdNear(p)).toBe(fullScan([body], p, 0.5));
    expect(v.faceIdNear(p)! >= 500).toBe(true);
  });
});
