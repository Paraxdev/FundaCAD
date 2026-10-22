// An edge pick skips a body whose segments are drawn denser than one a pixel, and keeps every other body its grab
// radius reaches, so zooming out of a big assembly no longer feeds every segment under the pointer to the hover.

import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { describe, expect, it } from "vitest";
import { EDGE_PICK_MAX_DENSITY, legibleEdgeTargets } from "../../src/viewport/picking";

const W = 800,
  H = 600,
  GRAB = 26;

/** A ring of `segments` segments, radius `r`, round `at`. */
function ring(segments: number, r: number, at: THREE.Vector3, mat: LineMaterial): LineSegments2 {
  const pos: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2,
      b = ((i + 1) / segments) * Math.PI * 2;
    pos.push(Math.cos(a) * r, Math.sin(a) * r, 0, Math.cos(b) * r, Math.sin(b) * r, 0);
  }
  const g = new LineSegmentsGeometry();
  g.setPositions(pos);
  const l = new LineSegments2(g, mat);
  l.position.copy(at);
  l.updateMatrixWorld(true);
  return l;
}

function camera(dist: number, ortho: boolean): THREE.Camera {
  const c = ortho
    ? new THREE.OrthographicCamera(-dist / 2, dist / 2, dist / 2.67, -dist / 2.67, 0.1, 1e6)
    : new THREE.PerspectiveCamera(45, W / H, 0.1, 1e6);
  c.position.set(0, 0, dist);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld(true);
  (c as THREE.PerspectiveCamera).updateProjectionMatrix();
  return c;
}

function field() {
  const mat = new LineMaterial({ linewidth: 1 });
  mat.resolution.set(W, H);
  const sparse: LineSegments2[] = [];
  const dense: LineSegments2[] = [];
  for (let i = 0; i < 6; i++) {
    const at = new THREE.Vector3((i - 2.5) * 3, (i % 3) - 1, -i);
    sparse.push(ring(32, 4 + i, at, mat));
    dense.push(ring(20000, 1 + i * 0.3, at, mat));
  }
  return { sparse, dense, all: [...sparse, ...dense] };
}

function hits(objs: THREE.Object3D[], cam: THREE.Camera) {
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(0, 0), cam);
  rc.params.Line2 = { threshold: GRAB };
  (rc as unknown as { camera: THREE.Camera }).camera = cam;
  return { rc, hits: rc.intersectObjects(objs, false) };
}

describe("legibleEdgeTargets", () => {
  it("keeps a dense body's edges close up, where its segments are pixels apart", () => {
    const { dense } = field();
    for (const ortho of [false, true]) {
      const cam = camera(ortho ? 4 : 6, ortho);
      const { rc } = hits(dense, cam);
      const kept = legibleEdgeTargets(dense, rc.ray, cam, H, GRAB);
      expect(kept.length).toBeGreaterThan(0);
    }
  });

  it("skips a dense body zoomed out, but never a sparse one the grab radius reaches", () => {
    const { sparse, dense, all } = field();
    for (const ortho of [false, true]) {
      for (const dist of [60, 400]) {
        const cam = camera(dist, ortho);
        const { rc, hits: every } = hits(all, cam);
        const kept = legibleEdgeTargets(all, rc.ray, cam, H, GRAB);
        expect(kept.some((o) => dense.includes(o as LineSegments2))).toBe(false);
        const reached = new Set(every.map((h) => h.object).filter((o) => sparse.includes(o as LineSegments2)));
        for (const o of reached) expect(kept).toContain(o);
      }
    }
  });

  it("leaves a pick zoomed far out a few hundred segment hits where it had every segment of the field", () => {
    const { all } = field();
    const cam = camera(3000, false);
    const { rc, hits: every } = hits(all, cam);
    const kept = legibleEdgeTargets(all, rc.ray, cam, H, GRAB);
    expect(every.length).toBeGreaterThan(100_000);
    expect(hits(kept, cam).hits.length).toBeLessThanOrEqual(6 * 32 * EDGE_PICK_MAX_DENSITY);
  });
});
