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

  it("works it out again when a kept body's face ids shift in place", () => {
    const g = new THREE.CylinderGeometry(8, 8, 30, 48, 2);
    const side = 48 * 2 * 2;
    const body = fakeBody("cyl", g, (t) => (t < side ? 0 : t < side + 48 ? 1 : 2));
    const model = modelOf(body);
    const [round, cap, other] = [...body.faceTriangles.entries()];
    const memo = new PressPullMemo();
    expect(memo.get(model, [cap![0]], null)!.round).toBeNull();
    // The same id now names the round side, as reuseUnchanged leaves it: same geometry, pose and body.
    body.faceTriangles = new Map([
      [cap![0], round![1]],
      [round![0], cap![1]],
      [other![0], other![1]],
    ]);
    expect(memo.get(model, [cap![0]], null)!.round?.radius).toBeCloseTo(8, 3);
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

describe("the sample of a dense face tessellated in rings", () => {
  // 32 segments round and 4,000 rings, sampled down to 4,000 triangles: the old pick of every 64th triangle, two
  // per segment a ring, landed on one generator line every time.
  const FIT = 4000;
  const ringed = (g: THREE.BufferGeometry, faceOf: (t: number) => number) => {
    const body = fakeBody("ringed", g, faceOf);
    return { model: modelOf(body), face: [...body.faceTriangles.keys()][0]! };
  };
  const agree = (model: ModelView, face: number, minDot: number) => {
    const sampled = pressPullOf(model, [face], null, FIT)!;
    const full = pressPullOf(model, [face], null, Infinity)!;
    expect(sampled.normal.dot(full.normal)).toBeGreaterThan(minDot);
    expect(sampled.round === null).toBe(full.round === null);
    if (full.round) expect(sampled.round!.radius).toBeCloseTo(full.round.radius, 2);
    return full;
  };
  const side = 32 * 4000 * 2;
  // three builds a cylinder's side column by column; a scanner's STL runs ring by ring, the order that aliased.
  const ringByRing = (g: THREE.BufferGeometry) => {
    const old = g.index!.array;
    const idx = Array.from(old);
    for (let x = 0; x < 32; x++)
      for (let y = 0; y < 4000; y++)
        for (let p = 0; p < 2; p++) {
          const from = ((x * 4000 + y) * 2 + p) * 3;
          const to = ((y * 32 + x) * 2 + p) * 3;
          for (let k = 0; k < 3; k++) idx[to + k] = old[from + k]!;
        }
    g.setIndex(idx);
    return g;
  };

  it("fits a dense cylinder as the whole face does", () => {
    const { model, face } = ringed(ringByRing(new THREE.CylinderGeometry(10, 10, 40, 32, 4000)), (t) =>
      t < side ? 0 : 1,
    );
    expect(agree(model, face, 0.9999).round).not.toBeNull();
  });

  it("points a dense sphere's handle out from its centre, as the whole face does", () => {
    const { model, face } = ringed(new THREE.SphereGeometry(10, 32, 4000), () => 0);
    agree(model, face, 0.9999);
  });

  it("points a dense cone's handle within a facet of where the whole face does", () => {
    const { model, face } = ringed(ringByRing(new THREE.CylinderGeometry(2, 10, 40, 32, 4000)), (t) =>
      t < side ? 0 : 1,
    );
    agree(model, face, Math.cos((2 * Math.PI) / 32) - 1e-6);
  });

  it("takes the same sample every time", () => {
    const { model, face } = ringed(new THREE.SphereGeometry(10, 32, 4000), () => 0);
    expect(pressPullOf(model, [face], null, FIT)).toEqual(pressPullOf(model, [face], null, FIT));
  });
});
