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

// A slanted camera looking at a ring off the origin, at the depth where the ring's drawn disc holds `scale` times as
// many pixels as it has segments.
function atDensity(segments: number, scale: number, ortho: boolean) {
  const mat = new LineMaterial({ linewidth: 1 });
  const l = ring(segments, 2.5, new THREE.Vector3(7.3, -4.1, 2.2), mat);
  l.rotation.set(0.4, -0.7, 0.2);
  l.updateMatrixWorld(true);
  l.geometry.computeBoundingSphere();
  const s = l.geometry.boundingSphere!.clone().applyMatrix4(l.matrixWorld);
  const dir = new THREE.Vector3(0.3, -0.5, 0.81).normalize();
  // Pixels per world unit that make the disc pi * (r * k)^2 equal scale * segments.
  const k = Math.sqrt((scale * segments) / Math.PI) / s.radius;
  let cam: THREE.Camera;
  if (ortho) {
    const o = new THREE.OrthographicCamera(-40, 40, 30, -30, 0.1, 1e6);
    o.zoom = (k * 60) / H;
    cam = o;
    cam.position.copy(s.center).addScaledVector(dir, 50);
  } else {
    const p = new THREE.PerspectiveCamera(38, W / H, 0.1, 1e6);
    p.zoom = 1.3;
    const depth = (H * 1.3) / (k * 2 * Math.tan(THREE.MathUtils.degToRad(38) / 2));
    cam = p;
    cam.position.copy(s.center).addScaledVector(dir, depth);
  }
  cam.lookAt(s.center);
  cam.updateMatrixWorld(true);
  (cam as THREE.PerspectiveCamera).updateProjectionMatrix();
  const ray = new THREE.Ray(cam.position.clone(), s.center.clone().sub(cam.position).normalize());
  return { l, cam, ray, s };
}

describe("legibleEdgeTargets guards", () => {
  it("keeps nothing of nothing", () => {
    const cam = camera(50, false);
    expect(
      legibleEdgeTargets([], new THREE.Ray(cam.position.clone(), new THREE.Vector3(0, 0, -1)), cam, H, GRAB),
    ).toEqual([]);
  });

  for (const ortho of [false, true]) {
    it(`keeps a body drawn at most one segment a pixel and skips one just denser (${ortho ? "ortho" : "perspective"})`, () => {
      for (const segments of [3, 37, 4096]) {
        const sparse = atDensity(segments, 1.000001, ortho);
        expect(legibleEdgeTargets([sparse.l], sparse.ray, sparse.cam, H, GRAB)).toEqual([sparse.l]);
        const dense = atDensity(segments, 0.999999, ortho);
        expect(legibleEdgeTargets([dense.l], dense.ray, dense.cam, H, GRAB)).toEqual([]);
      }
    });
  }

  it("skips a sparse body whose sphere the grab radius does not reach, and keeps it once it does", () => {
    const { l, cam, ray, s } = atDensity(16, 50, false);
    const depth = cam.position.distanceTo(s.center);
    const pxWorld = (2 * Math.tan(THREE.MathUtils.degToRad(38) / 2)) / (1.3 * H);
    const reach = GRAB * pxWorld * (depth + s.radius);
    const side = new THREE.Vector3().crossVectors(ray.direction, new THREE.Vector3(0.2, 0.9, -0.1)).normalize();
    const aimAt = (gap: number) =>
      new THREE.Ray(
        ray.origin.clone(),
        s.center
          .clone()
          .addScaledVector(side, s.radius + gap)
          .sub(ray.origin)
          .normalize(),
      );
    expect(legibleEdgeTargets([l], aimAt(reach * 0.9), cam, H, GRAB)).toEqual([l]);
    expect(legibleEdgeTargets([l], aimAt(reach * 1.2), cam, H, GRAB)).toEqual([]);
  });

  it("keeps a dense body the camera stands inside, which fills the view", () => {
    const { l, ray, s } = atDensity(50_000, 1e-6, false);
    const inside = new THREE.PerspectiveCamera(38, W / H, 0.1, 1e6);
    inside.position.copy(s.center).addScaledVector(ray.direction, -s.radius * 0.6);
    inside.lookAt(s.center);
    inside.updateMatrixWorld(true);
    const r = new THREE.Ray(inside.position.clone(), s.center.clone().sub(inside.position).normalize());
    expect(legibleEdgeTargets([l], r, inside, H, GRAB)).toEqual([l]);
  });

  it("passes through objects it cannot measure, and every target for a camera of neither kind", () => {
    const { l, cam, ray } = atDensity(4096, 1e-3, false);
    const group = new THREE.Group();
    expect(legibleEdgeTargets([group, l], ray, cam, H, GRAB)).toEqual([group]);
    expect(legibleEdgeTargets([group, l], ray, new THREE.Camera(), H, GRAB)).toEqual([group, l]);
  });
});
