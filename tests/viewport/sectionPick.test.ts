import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { computeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { applyKeptSpan, firstKeptHit, keptPoint, keptSpan } from "../../src/viewport/sectionPick";

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

describe("firstKeptHit on a closed body cut through its middle", () => {
  const C = new THREE.Vector3(63, -21, 14);
  const m = new THREE.Vector3(2, -1, 6).normalize();
  const cut = new THREE.Plane().setFromNormalAndCoplanarPoint(m, C);
  const u = new THREE.Vector3(1, 2, 0).cross(m).normalize();
  const crossing = (r: THREE.Ray) => r.distanceToPlane(new THREE.Plane(m, cut.constant + SLACK))!;
  const body = (bvh: boolean, halfTurn = false) => {
    const geo = new THREE.BoxGeometry(40, 30, 36);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    if (bvh) {
      computeBoundsTree.call(geo);
      mesh.raycast = acceleratedRaycast;
    }
    mesh.position.copy(C);
    // A half turn across the ray leaves the wall's normal, read in the mesh's own frame, pointing back at the ray.
    if (halfTurn) mesh.quaternion.setFromAxisAngle(u, Math.PI);
    else mesh.rotation.set(2.6, -0.4, 1.9);
    mesh.updateMatrixWorld();
    return mesh;
  };
  const cast = (r: THREE.Ray, plane: THREE.Plane | null, meshes: THREE.Mesh[], bvh = false) => {
    const rc = Object.assign(new THREE.Raycaster(r.origin, r.direction), { firstHitOnly: bvh });
    const k = firstKeptHit(rc, meshes, plane, SLACK);
    return k && { cap: k.cap, distance: k.distance, wall: k.hit.distance };
  };
  // From the removed half, crossing the cut at 7 mm from C, which is inside the box.
  const intoCap = new THREE.Ray(C.clone().addScaledVector(m, -150).addScaledVector(u, 7), m.clone().addScaledVector(u, 0.02).normalize());

  it("a ray that enters the kept half inside the body is on the cap, at the cut", () => {
    for (const [bvh, halfTurn] of [[false, false], [true, false], [false, true]]) {
      const got = cast(intoCap, cut, [body(bvh!, halfTurn)], bvh)!;
      expect(got).toEqual({ cap: true, distance: expect.closeTo(crossing(intoCap), 9), wall: expect.any(Number) });
      expect(got.wall - got.distance).toBeGreaterThan(5);
    }
  });

  it("the same ray without the cut hits the outside of the removed half", () => {
    const got = cast(intoCap, null, [body(false)])!;
    expect(got).toEqual({ cap: false, distance: got.wall, wall: expect.any(Number) });
    expect(got.wall).toBeLessThan(crossing(intoCap) - 5);
  });

  it("a ray that crosses the cut beside the body reaches its kept outside, no cap", () => {
    const from = C.clone().addScaledVector(m, -3).addScaledVector(u, 80);
    const to = C.clone().addScaledVector(m, 6);
    const r = new THREE.Ray(from, to.clone().sub(from).normalize());
    expect(r.at(crossing(r), new THREE.Vector3()).distanceTo(C)).toBeGreaterThan(40);
    const got = cast(r, cut, [body(true)], true)!;
    expect(got).toEqual({ cap: false, distance: got.wall, wall: expect.any(Number) });
    expect(got.wall).toBeGreaterThan(crossing(r));
  });

  it("a ray from inside the body in the kept half sees its wall from inside, which is no cap", () => {
    const r = new THREE.Ray(C.clone().addScaledVector(m, 4).addScaledVector(u, -3), m.clone().addScaledVector(u, 0.3).normalize());
    const got = cast(r, cut, [body(false)])!;
    expect(got).toEqual({ cap: false, distance: got.wall, wall: expect.any(Number) });
    expect(got.wall).toBeLessThan(25);
  });

  it("no body, or nothing kept along the ray, is no hit", () => {
    expect(cast(intoCap, cut, [])).toBeNull();
    const away = new THREE.Ray(intoCap.origin, intoCap.direction.clone().negate());
    expect(cast(away, cut, [body(true)], true)).toBeNull();
  });
});

describe("firstKeptHit takes the cap only where a body holds the crossing", () => {
  const C = new THREE.Vector3(-37, 52, 21);
  const m = new THREE.Vector3(-1, 3, 5).normalize();
  const u = new THREE.Vector3(4, 1, 0).cross(m).normalize();
  const cut = new THREE.Plane().setFromNormalAndCoplanarPoint(m, C);
  const frame = new THREE.Matrix4().makeBasis(u, m.clone().cross(u), m);
  const crossing = (r: THREE.Ray) => r.distanceToPlane(new THREE.Plane(m, cut.constant + SLACK))!;
  // A body in the cut's frame: x along u, z along m. BoxGeometry's face groups: +x, -x, +y, -y, +z, -z.
  const mesh = (name: string, geo: THREE.BufferGeometry, at: THREE.Vector3, bvh: boolean, halfTurn = false) => {
    const me = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    if (bvh) {
      computeBoundsTree.call(geo);
      me.raycast = acceleratedRaycast;
    }
    me.name = name;
    me.quaternion.setFromRotationMatrix(frame);
    if (halfTurn) me.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
    me.position.copy(C).addScaledVector(u, at.x).addScaledVector(m.clone().cross(u), at.y).addScaledVector(m, at.z);
    me.updateMatrixWorld();
    return me;
  };
  const box = (size: [number, number, number], edit: { drop?: number; dup?: number; flip?: boolean } = {}) => {
    const g = new THREE.BoxGeometry(...size);
    const idx = Array.from(g.getIndex()!.array);
    let out = idx.filter((_, i) => Math.floor(i / 6) !== edit.drop);
    if (edit.dup !== undefined) out = out.concat(idx.slice(edit.dup * 6, edit.dup * 6 + 6));
    if (edit.flip) for (let i = 0; i < out.length; i += 3) [out[i + 1], out[i + 2]] = [out[i + 2]!, out[i + 1]!];
    g.setIndex(out);
    g.clearGroups();
    return g;
  };
  const cast = (r: THREE.Ray, meshes: THREE.Mesh[], bvh: boolean) => {
    const rc = Object.assign(new THREE.Raycaster(r.origin.clone(), r.direction.clone()), { firstHitOnly: bvh });
    const k = firstKeptHit(rc, meshes, cut, SLACK);
    return k && { cap: k.cap, distance: k.distance, body: k.hit.object.name, past: k.hit.distance - crossing(r) };
  };
  // From the removed half, crossing the cut 7 mm off C along u, a little slanted.
  const ray = new THREE.Ray(C.clone().addScaledVector(m, -140).addScaledVector(u, 7), m.clone().addScaledVector(u, 0.02).normalize());
  const at = (x: number, z: number) => new THREE.Vector3(x, -2, z);

  it("an open sheet in the kept half is picked from either side, in front of it or behind", () => {
    for (const bvh of [false, true]) {
      for (const halfTurn of [false, true]) {
        const sheet = mesh("sheet", new THREE.PlaneGeometry(30, 26), at(4, 11), bvh, halfTurn);
        expect(cast(ray, [sheet], bvh)).toEqual({ cap: false, distance: expect.closeTo(crossing(ray) + 11, 1), body: "sheet", past: expect.closeTo(11, 1) });
      }
    }
  });

  it("a closed box cut through is on the cap, the same box open on its removed end is not", () => {
    for (const bvh of [false, true]) {
      const closed = cast(ray, [mesh("box", box([40, 30, 36]), at(0, 0), bvh)], bvh);
      expect(closed).toEqual({ cap: true, distance: expect.closeTo(crossing(ray), 6), body: "box", past: expect.closeTo(18, 0) });
      const open = cast(ray, [mesh("box", box([40, 30, 36], { drop: 5 }), at(0, 0), bvh)], bvh);
      expect(open).toEqual({ cap: false, distance: expect.closeTo(crossing(ray) + 18, 0), body: "box", past: expect.closeTo(18, 0) });
    }
  });

  it("a box wound inside out, with a doubled face where the ray leaves, or with a two sided fin inside is on the cap", () => {
    const flipped = cast(ray, [mesh("box", box([40, 30, 36], { flip: true }), at(0, 0), false)], false);
    expect(flipped).toEqual({ cap: true, distance: expect.closeTo(crossing(ray), 6), body: "box", past: expect.closeTo(18, 0) });
    const doubled = cast(ray, [mesh("box", box([40, 30, 36], { dup: 4 }), at(0, 0), false)], false);
    expect(doubled).toEqual({ cap: true, distance: expect.closeTo(crossing(ray), 6), body: "box", past: expect.closeTo(18, 0) });
    // The fin's two faces lie back to back, so the ray meets a front and a back at one distance, as on a grazed edge.
    const face = new THREE.PlaneGeometry(12, 10).translate(7, 2, 8);
    const back = face.clone();
    back.setIndex(Array.from(face.getIndex()!.array).map((_, i, a) => a[i - (i % 3) + [0, 2, 1][i % 3]!]!));
    const finned = cast(ray, [mesh("box", mergeGeometries([box([40, 30, 36]), face, back]), at(0, 0), false)], false);
    expect(finned).toEqual({ cap: true, distance: expect.closeTo(crossing(ray), 6), body: "box", past: expect.closeTo(8, 0) });
  });

  it("a body inside a cut body is hidden by that body's cap, and picked once the outer body is gone", () => {
    for (const bvh of [false, true]) {
      const outer = mesh("outer", box([40, 30, 36]), at(0, 0), bvh);
      const inner = mesh("inner", box([9, 8, 6]), at(6, 7), bvh);
      for (const meshes of [[outer, inner], [inner, outer]]) {
        expect(cast(ray, meshes, bvh)).toEqual({ cap: true, distance: expect.closeTo(crossing(ray), 6), body: "outer", past: expect.closeTo(18, 0) });
      }
      expect(cast(ray, [inner], bvh)).toEqual({ cap: false, distance: expect.closeTo(crossing(ray) + 4, 1), body: "inner", past: expect.closeTo(4, 1) });
    }
  });

  it("a ray that crosses the cut beside every body reaches the first body it meets, no cap", () => {
    const beside = new THREE.Ray(ray.origin.clone().addScaledVector(u, 30), ray.direction.clone());
    const outer = mesh("outer", box([40, 30, 36]), at(0, 0), true);
    const sheet = mesh("sheet", new THREE.PlaneGeometry(30, 26), at(31, 11), true);
    expect(cast(beside, [outer, sheet], true)).toEqual({ cap: false, distance: expect.closeTo(crossing(beside) + 11, 1), body: "sheet", past: expect.closeTo(11, 1) });
  });
});
