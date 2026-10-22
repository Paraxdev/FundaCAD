import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { computeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { applyKeptSpan, keptPoint, keptSpan } from "../../src/viewport/sectionPick";

const n = new THREE.Vector3(3, -4, 12).divideScalar(13);
const plane = new THREE.Plane(n.clone(), -40);
const SLACK = 0.02;
const keptOrigin = new THREE.Vector3(210, -150, 340);
const removedOrigin = new THREE.Vector3(-60, 85, -120);
const intoRemoved = new THREE.Vector3(-2, 1.5, -5).normalize();
const intoKept = new THREE.Vector3(1, -2, 4).normalize();
// The boundary a ray may reach: points up to SLACK on the removed side still count as kept.
const edge = new THREE.Plane(n.clone(), -40 + SLACK);
const tTo = (o: THREE.Vector3, d: THREE.Vector3) => new THREE.Ray(o, d).distanceToPlane(edge)!;

describe("keptSpan", () => {
  it("a ray from the kept half toward the cut ends at the cut", () => {
    expect(keptSpan(new THREE.Ray(keptOrigin, intoRemoved), plane, SLACK))
      .toEqual({ near: 0, far: expect.closeTo(tTo(keptOrigin, intoRemoved), 9) });
  });

  it("a ray from the kept half away from the cut is kept whole", () => {
    expect(keptSpan(new THREE.Ray(keptOrigin, intoKept), plane, SLACK)).toEqual({ near: 0, far: Infinity });
  });

  it("a ray from the removed half toward the cut starts at the cut", () => {
    expect(keptSpan(new THREE.Ray(removedOrigin, intoKept), plane, SLACK))
      .toEqual({ near: expect.closeTo(tTo(removedOrigin, intoKept), 9), far: Infinity });
  });

  it("a ray from the removed half away from the cut keeps nothing", () => {
    expect(keptSpan(new THREE.Ray(removedOrigin, intoRemoved), plane, SLACK)).toBeNull();
  });

  it("a ray parallel to the cut is kept whole or not at all", () => {
    const along = new THREE.Vector3(1, 2, -0.5).cross(n).normalize();
    expect(keptSpan(new THREE.Ray(keptOrigin, along), plane, SLACK)).toEqual({ near: 0, far: Infinity });
    expect(keptSpan(new THREE.Ray(removedOrigin, along), plane, SLACK)).toBeNull();
  });

  it("a ray just off parallel still ends at the cut, far away", () => {
    const along = new THREE.Vector3(1, 2, -0.5).cross(n).normalize();
    const slight = along.clone().addScaledVector(n, -1e-6).normalize();
    const span = keptSpan(new THREE.Ray(keptOrigin, slight), plane, SLACK);
    expect(span).toEqual({ near: 0, far: expect.closeTo(tTo(keptOrigin, slight), 0) });
    expect(span!.far).toBeGreaterThan(1e8);
  });

  it("from a point on the cut, a ray into the removed half reaches the slack and no further", () => {
    const on = plane.projectPoint(keptOrigin, new THREE.Vector3());
    expect(keptSpan(new THREE.Ray(on, intoRemoved), plane, SLACK))
      .toEqual({ near: 0, far: expect.closeTo(SLACK / Math.abs(n.dot(intoRemoved)), 9) });
  });

  it("from exactly the slack's depth the span is a single point, a little deeper it is empty", () => {
    const o = plane.projectPoint(keptOrigin, new THREE.Vector3()).addScaledVector(n, -0.05);
    const depth = -plane.distanceToPoint(o);
    expect(keptSpan(new THREE.Ray(o, intoRemoved), plane, depth)).toEqual({ near: 0, far: 0 });
    expect(keptSpan(new THREE.Ray(o, intoKept), plane, depth)).toEqual({ near: 0, far: Infinity });
    expect(keptSpan(new THREE.Ray(o, intoRemoved), plane, depth / 1.01)).toBeNull();
  });
});

describe("keptPoint", () => {
  const onCut = plane.projectPoint(new THREE.Vector3(57, 23, -8), new THREE.Vector3());
  it("keeps a point up to the slack past the cut and drops one beyond it", () => {
    const p = onCut.clone().addScaledVector(n, -0.05);
    const depth = -plane.distanceToPoint(p);
    expect([
      keptPoint(p, plane, depth),
      keptPoint(p, plane, depth / 1.01),
      keptPoint(onCut.clone().addScaledVector(n, 3), plane, depth),
    ]).toEqual([true, false, true]);
  });
});

function box(name: string, at: THREE.Vector3, bvh: boolean): THREE.Mesh {
  const geo = new THREE.BoxGeometry(20, 30, 25);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  if (bvh) {
    computeBoundsTree.call(geo);
    mesh.raycast = acceleratedRaycast;
  }
  mesh.name = name;
  mesh.position.copy(at);
  mesh.rotation.set(0.3, -0.5, 0.8);
  mesh.updateMatrixWorld();
  return mesh;
}

describe("applyKeptSpan on a real raycast", () => {
  const ray = new THREE.Ray(keptOrigin, intoRemoved);
  // The cut sits between the two boxes and keeps the far one.
  const cut = new THREE.Plane().setFromNormalAndCoplanarPoint(n.clone().negate(), ray.at(200, new THREE.Vector3()));
  const hitNames = (bvh: boolean, clip: THREE.Plane | null) => {
    const rc = Object.assign(new THREE.Raycaster(ray.origin, ray.direction), { firstHitOnly: true });
    const meshes = [box("near", ray.at(100, new THREE.Vector3()), bvh), box("far", ray.at(300, new THREE.Vector3()), bvh)];
    expect(applyKeptSpan(rc, clip, SLACK)).toBe(true);
    return rc.intersectObjects(meshes, false).map((h) => h.object.name);
  };

  it("a BVH raycast finds the kept box behind a removed one", () => {
    expect(hitNames(true, cut)).toEqual(["far"]);
    expect(hitNames(true, null)).toEqual(["near", "far"]);
  });

  // The case the span exists for: one body, one BVH, whose first hit is its removed near part.
  it("a first-hit BVH raycast on one body finds its kept part behind its removed one", () => {
    const parts = [box("near", ray.at(100, new THREE.Vector3()), false), box("far", ray.at(300, new THREE.Vector3()), false)];
    const alone = parts.map((m) => Math.round(new THREE.Raycaster(ray.origin, ray.direction).intersectObject(m)[0]!.distance));
    const geo = mergeGeometries(parts.map((m) => m.geometry.clone().applyMatrix4(m.matrixWorld)))!;
    computeBoundsTree.call(geo);
    const body = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    body.raycast = acceleratedRaycast;
    const cast = (clip: THREE.Plane | null) => {
      const rc = Object.assign(new THREE.Raycaster(ray.origin, ray.direction), { firstHitOnly: true });
      applyKeptSpan(rc, clip, SLACK);
      return rc.intersectObject(body, false).map((h) => Math.round(h.distance));
    };
    expect(cast(cut)).toEqual([alone[1]]);
    expect(cast(null)).toEqual([alone[0]]);
    expect(alone[0]! < 200 && alone[1]! > 200).toBe(true);
  });

  it("a plain mesh raycast does the same", () => {
    expect(hitNames(false, cut)).toEqual(["far"]);
    expect(hitNames(false, null)).toEqual(["near", "far"]);
  });

  it("a ray wholly in the removed half hits nothing", () => {
    const rc = new THREE.Raycaster(removedOrigin, intoRemoved);
    const meshes = [box("a", rc.ray.at(60, new THREE.Vector3()), true), box("b", rc.ray.at(140, new THREE.Vector3()), false)];
    expect(applyKeptSpan(rc, plane, SLACK)).toBe(false);
    expect(rc.intersectObjects(meshes, false)).toEqual([]);
  });

  it("no plane puts a clipped raycaster back to the whole ray", () => {
    const rc = new THREE.Raycaster(removedOrigin, intoKept);
    applyKeptSpan(rc, plane, SLACK);
    expect(rc.near).toBeGreaterThan(10);
    expect(applyKeptSpan(rc, null, SLACK)).toBe(true);
    expect({ near: rc.near, far: rc.far }).toEqual({ near: 0, far: Infinity });
  });
});
