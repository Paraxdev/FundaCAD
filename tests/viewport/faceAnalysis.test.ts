// Releasing a box that took one face of a dense mesh froze the page for seconds: the release's three listeners each
// asked the viewport for the press pull handle, and each answer walked the face several times. These count the walks.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { faceWalks, FIT_TRIS, planeOfFace, PressPullMemo, pressPullOf } from "../../src/viewport/faceAnalysis";
import type { ModelView } from "../../src/viewport/render";
import { fakeBody } from "./areaModel";

const modelOf = (...bodies: ReturnType<typeof fakeBody>[]) =>
  ({ bodies, edges: [], orphanEdges: null, box: new THREE.Box3() }) as unknown as ModelView;

describe("the press pull answer for a selection", () => {
  it("walks the face once per selection, however many listeners ask", () => {
    const ball = fakeBody("ball", new THREE.SphereGeometry(10, 32, 24), () => 0);
    const model = modelOf(ball);
    const face = [...ball.faceTriangles.keys()];
    const memo = new PressPullMemo();
    faceWalks.count = 0;
    const a = memo.get(model, face, null);
    const walks = faceWalks.count;
    expect(walks).toBeGreaterThan(0);
    const b = memo.get(model, face, null);
    const c = memo.get(model, face, null);
    expect(faceWalks.count).toBe(walks);
    expect(b).toEqual(a);
    // Each caller may change its copy.
    b!.normal.set(0, 0, 0);
    b!.anchor.x += 5;
    expect(c!.normal.length()).toBeCloseTo(1);
    expect(memo.get(model, face, null)!.anchor.x).toBe(a!.anchor.x);
  });

  it("works it out again when the body moves or the click changes", () => {
    const ball = fakeBody("ball", new THREE.SphereGeometry(10, 16, 12), () => 0);
    const model = modelOf(ball);
    const face = [...ball.faceTriangles.keys()];
    const memo = new PressPullMemo();
    const before = memo.get(model, face, null)!;
    ball.mesh.position.set(30, 0, 0);
    ball.mesh.updateMatrixWorld(true);
    const moved = memo.get(model, face, null)!;
    expect(moved.anchor.x - before.anchor.x).toBeCloseTo(30);
    faceWalks.count = 0;
    memo.get(model, face, [40, 0, 0]);
    expect(faceWalks.count).toBeGreaterThan(0);
  });

  it("walks a dense face once for each of its centre and normal, and fits a sample", () => {
    const torus = new THREE.TorusGeometry(60, 20, 300, 400);
    const mesh = fakeBody("mesh", torus, () => 0);
    const n = torus.index!.count / 3;
    expect(n).toBeGreaterThan(FIT_TRIS * 10);
    faceWalks.count = 0;
    faceWalks.triangles = 0;
    pressPullOf(modelOf(mesh), [...mesh.faceTriangles.keys()], null);
    // The centre, the normal, and one strided sample for the shape fits, never the face a fourth time.
    expect(faceWalks.count).toBe(3);
    expect(faceWalks.triangles).toBeLessThanOrEqual(2 * n + FIT_TRIS);
  });
});

describe("a release that took one dense mesh face", () => {
  it("walks the face for its centre and normal once, and the plane check stops at once", () => {
    const torus = new THREE.TorusGeometry(60, 20, 300, 400);
    const mesh = fakeBody("mesh", torus, () => 0);
    const model = modelOf(mesh);
    const face = [...mesh.faceTriangles.keys()];
    const n = torus.index!.count / 3;
    const memo = new PressPullMemo();
    faceWalks.count = 0;
    faceWalks.triangles = 0;
    // What the release asks: two nudge refreshes, the selection readout, and the tool rail's sketch on face check.
    memo.get(model, face, null);
    memo.get(model, face, null);
    memo.get(model, face, null);
    expect(planeOfFace(model, face[0]!, 0.1)).toBeNull();
    expect(planeOfFace(model, face[0]!, 0.1)).toBeNull();
    expect(faceWalks.count).toBe(3);
    expect(faceWalks.triangles).toBeLessThan(2 * n + FIT_TRIS + 100);
  });

  it("still finds a flat face's plane, and keeps it", () => {
    const g = new THREE.CylinderGeometry(8, 8, 30, 48, 2);
    const side = 48 * 2 * 2;
    const body = fakeBody("cyl", g, (t) => (t < side ? 0 : t < side + 48 ? 1 : 2));
    const [round, cap] = [...body.faceTriangles.keys()];
    const model = modelOf(body);
    expect(planeOfFace(model, round!, 1e-3)).toBeNull();
    const p = planeOfFace(model, cap!, 1e-3)!;
    expect(Math.abs(p.normal.y)).toBeCloseTo(1, 6);
    faceWalks.triangles = 0;
    expect(planeOfFace(model, cap!, 1e-3)).toEqual(p);
    expect(faceWalks.triangles).toBe(0);
  });
});

describe("the answer on a CAD sized face is the one it always was", () => {
  // Faces of a cylinder: its side, then the two caps.
  const cylinder = () => {
    const g = new THREE.CylinderGeometry(8, 8, 30, 48, 2);
    const side = 48 * 2 * 2;
    return fakeBody("cyl", g, (t) => (t < side ? 0 : t < side + 48 ? 1 : 2));
  };

  it("finds the round side and its radius", () => {
    const body = cylinder();
    const [side] = [...body.faceTriangles.keys()];
    const got = pressPullOf(modelOf(body), [side!], null)!;
    expect(got.round?.radius).toBeCloseTo(8, 3);
    expect(got.lead).toBeNull();
  });

  it("points a flat cap's handle along its normal", () => {
    const body = cylinder();
    const caps = [...body.faceTriangles.keys()].slice(1);
    const top = pressPullOf(modelOf(body), [caps[0]!], null)!;
    expect(top.round).toBeNull();
    expect(Math.abs(top.normal.y)).toBeCloseTo(1, 6);
    expect(top.anchor.y).toBeCloseTo(15, 6);
  });

  it("points a sphere's handle out from its centre", () => {
    const ball = fakeBody("ball", new THREE.SphereGeometry(10, 32, 24), () => 0, new THREE.Vector3(5, 0, 0));
    const got = pressPullOf(modelOf(ball), [...ball.faceTriangles.keys()], null)!;
    const out = got.anchor
      .clone()
      .sub(new THREE.Vector3(5, 0, 0))
      .normalize();
    expect(got.normal.dot(out)).toBeCloseTo(1, 3);
  });
});
