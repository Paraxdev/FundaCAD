// The near plane over a big assembly goes by the parts that can be on screen,
// not by the corners of the union box, which reach the eye plane first.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createNavigatorRig } from "../../../src/viewport/navigator/rig";
import { visibleNearDepth } from "../../../src/viewport/navigator/anchor";
import { makePose } from "../../../src/viewport/navigator/pose";

const W = 1485;
const H = 784;

function stubCanvas() {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
  } as unknown as HTMLElement;
}

const box = (a: [number, number, number], b: [number, number, number]) =>
  new THREE.Box3(new THREE.Vector3(...a), new THREE.Vector3(...b));

// The Sovol SV08 frame STEP as measured in the running app: its union box, the
// PEI sheet over the magnetic sheet over the heated bed, and the one tall part
// that reaches the union box's top.
const UNION = box([-342.8, -62.7, -164.5], [370.5, 766.6, 425.1]);
const PEI = box([-245.5, 45.147, -23.8], [109.5, 45.547, 343.2]);
const MAGNET = box([-245.5, 43.147, -23.8], [109.5, 45.147, 343.2]);
const BED = box([-245.5, 39.137, -23.8], [109.5, 43.147, 343.2]);
const MAST = box([-20, 400, 82.9], [20, 766.6, 142.9]);
const FRAME = box([-342.8, -62.7, -164.5], [370.5, 30, 425.1]);
const PARTS = [PEI, MAGNET, BED, MAST, FRAME];
const TARGET = new THREE.Vector3(-68, 45.55, 160);
const DIR = new THREE.Vector3(0, 0.8, -0.6).normalize();

function rigAt(d: number, parts?: readonly THREE.Box3[]) {
  const rig = createNavigatorRig(stubCanvas(), W / H);
  rig.setProjectionMode("persp");
  rig.resize(W, H);
  rig.setContentBox(UNION, parts);
  rig.setLookAt(TARGET.clone().addScaledVector(DIR, d), TARGET.clone(), false);
  return rig.active as THREE.PerspectiveCamera;
}

/** One step of a 24 bit depth buffer at view depth z. */
const depthStep = (cam: THREE.PerspectiveCamera, z: number) =>
  (z * z * (cam.far - cam.near)) / (cam.far * cam.near * 2 ** 24);

describe("near plane from the parts on screen", () => {
  it("resolves the SV08 bed sheets in the zoom band where they fought", () => {
    for (const d of [550.7, 584.3, 657.6, 718.6, 762.3]) {
      const cam = rigAt(d, PARTS);
      expect(cam.position.distanceTo(TARGET)).toBeCloseTo(d, 3);
      expect(depthStep(cam, 900)).toBeLessThan(0.05);
    }
  });

  it("held near at 0.1mm in that band while only the union box was known", () => {
    expect(rigAt(584.3).near).toBe(0.1);
    expect(depthStep(rigAt(584.3), 900)).toBeGreaterThan(0.4);
  });

  it("never puts near past a part that can be on screen", () => {
    for (const d of [150, 400, 584.3, 1000, 2500]) {
      const cam = rigAt(d, PARTS);
      const eye = cam.position;
      const fwd = cam.getWorldDirection(new THREE.Vector3());
      const frustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
      );
      const c = new THREE.Vector3();
      for (const p of PARTS) {
        const hit = new THREE.Box3().copy(p);
        let lo = Infinity;
        for (let i = 0; i < 8; i++) {
          c.set(i & 1 ? p.max.x : p.min.x, i & 2 ? p.max.y : p.min.y, i & 4 ? p.max.z : p.min.z);
          lo = Math.min(lo, c.sub(eye).dot(fwd));
        }
        if (frustum.intersectsBox(hit) && lo > 0) expect(cam.near).toBeLessThanOrEqual(lo);
      }
    }
  });
});

describe("visibleNearDepth", () => {
  const pose = makePose();
  pose.target.set(0, 0, 0);
  pose.q.identity();
  pose.scale = 100 * Math.tan(Math.PI / 8);
  pose.fov = 45;

  it("takes the nearest box in view and skips one off to the side", () => {
    const ahead = box([-5, -5, -50], [5, 5, -40]);
    const aside = box([500, -5, -30], [510, 5, -20]);
    expect(visibleNearDepth(pose, 1, [ahead, aside])).toBeCloseTo(140, 6);
  });

  it("takes a part running past the eye from where it enters the view", () => {
    const pole = box([-5, 20, -100], [5, 30, 200]);
    expect(visibleNearDepth(pose, 1, [pole])).toBeCloseTo(20 / (Math.tan(Math.PI / 8) * 1.02), 6);
  });

  it("is 0 for a box holding the eye, NaN with none in view", () => {
    expect(visibleNearDepth(pose, 1, [box([-5, -5, 90], [5, 5, 120])])).toBe(0);
    expect(visibleNearDepth(pose, 1, [box([-5, -5, 110], [5, 5, 120])])).toBeNaN();
    expect(visibleNearDepth(pose, 1, [])).toBeNaN();
  });
});
