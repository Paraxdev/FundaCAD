// The Picker under a section cut, with real body meshes and edge lines: a click, a hover and Measure go through
// pick() and pickEdgeCandidates(), so those must skip what the cut removes and reach what it keeps behind it.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Picker } from "../../src/viewport/picking";
import { buildBodyMesh, type ModelView } from "../../src/viewport/render";
import type { RebuildResult } from "../../src/types";

const W = 800, H = 600;
const RECT = { left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 } as DOMRect;

const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 5000);
camera.position.set(150, -170, 130);
camera.lookAt(40, 25, -10);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();
const sight = new THREE.Vector3(40, 25, -10).sub(camera.position).normalize();
const along = (t: number) => camera.position.clone().addScaledVector(sight, t);

// A small body in front of a big one on the line of sight, so every edge of the small one is drawn over the big one.
const PARTS = [
  { id: "near", size: [24, 18, 30], at: along(180), rot: new THREE.Euler(0.4, -0.3, 0.7) },
  { id: "far", size: [80, 70, 90], at: along(330), rot: new THREE.Euler(-0.2, 0.5, 0.3) },
] as const;

function reply(): RebuildResult {
  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const edges: RebuildResult["edges"] = [];
  const box = new THREE.Box3();
  PARTS.forEach((p, b) => {
    const m = new THREE.Matrix4().compose(p.at, new THREE.Quaternion().setFromEuler(p.rot), new THREE.Vector3(1, 1, 1));
    const g = new THREE.BoxGeometry(...p.size).applyMatrix4(m);
    const base = positions.length / 3;
    positions.push(...g.getAttribute("position").array);
    const idx = g.getIndex()!.array;
    for (let i = 0; i < idx.length; i++) indices.push(base + idx[i]!);
    for (let t = 0; t < idx.length / 3; t++) faceIds.push(b * 6 + Math.floor(t / 2));
    const lines = new THREE.EdgesGeometry(g).getAttribute("position");
    for (let i = 0; i < lines.count; i += 2) {
      const a = new THREE.Vector3().fromBufferAttribute(lines, i);
      const c = new THREE.Vector3().fromBufferAttribute(lines, i + 1);
      edges.push({ id: `${p.id}-e${i / 2}`, points: [a.toArray(), c.toArray()], body: p.id });
    }
    g.computeBoundingBox();
    box.union(g.boundingBox!);
  });
  return {
    mesh: { positions, indices, faceIds },
    edges,
    bbox: { min: box.min.toArray(), max: box.max.toArray() },
    bodies: PARTS.map((p, b) => ({ id: p.id, name: p.id, faceStart: b * 6, faceCount: 6 })),
  };
}

function view(): ModelView {
  const r = reply();
  const res = new THREE.Vector2(W, H);
  const bodies = r.bodies!.map((b) => buildBodyMesh(r, b, r.edges.filter((e) => e.body === b.id), res, undefined));
  return {
    bodies,
    edges: [],
    orphanEdges: null,
    box: new THREE.Box3(new THREE.Vector3(...r.bbox.min), new THREE.Vector3(...r.bbox.max)),
  };
}

const bodyOf = (faceId: number) => (faceId < 6 ? "near" : "far");
const screenOf = (p: THREE.Vector3) => {
  const s = p.clone().project(camera);
  return { x: (s.x * 0.5 + 0.5) * W, y: (-s.y * 0.5 + 0.5) * H };
};
// Between the two bodies, slanted to the line of sight, keeping the far side.
const cut = new THREE.Plane().setFromNormalAndCoplanarPoint(
  sight.clone().add(new THREE.Vector3(0.25, -0.15, 0.3)).normalize(),
  along(250),
);

describe("the Picker under a section cut", () => {
  it("a click on the removed body picks the kept body's face behind it", () => {
    const v = view();
    const picker = new Picker();
    const hitBody = () => {
      const h = picker.pick(W / 2, H / 2, RECT, camera, v);
      return h?.kind === "face" ? bodyOf(h.faceId) : h?.kind ?? null;
    };
    expect(hitBody()).toBe("near");
    picker.setClip(cut);
    expect(hitBody()).toBe("far");
    picker.setClip(null);
    expect(hitBody()).toBe("near");
  });

  it("edges of the removed body are no candidates, and a pick on one lands on the kept body", () => {
    const v = view();
    const picker = new Picker();
    const mid = (id: string) => {
      const e = reply().edges.find((x) => x.id === id)!;
      return new THREE.Vector3(...e.points[0]!).add(new THREE.Vector3(...e.points[1]!)).multiplyScalar(0.5);
    };
    const ids = ["near-e0", "near-e5", "near-e9"];
    const at = ids.map((id) => screenOf(mid(id)));
    const cands = () => at.map((p) => picker.pickEdgeCandidates(p.x, p.y, RECT, camera, v).map((c) => c.edge.id));
    expect(cands().map((c) => c[0])).toEqual(ids);
    picker.setClip(cut);
    expect(cands()).toEqual([["far-e9"], [], []]);
    const picked = at.map((p) => {
      const h = picker.pick(p.x, p.y, RECT, camera, v);
      return h?.kind === "face" ? bodyOf(h.faceId) : h?.kind === "edge" ? h.edge.body : null;
    });
    expect(picked).toEqual(["far", "far", "far"]);
  });
});
