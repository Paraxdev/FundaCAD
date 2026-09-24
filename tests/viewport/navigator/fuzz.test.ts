// Ten thousand random operations at scales from a micron-sized part to a
// kilometre-sized one: every number stays finite and inside its limits.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { BoxScene, W, H, rng } from "./kit";
import { Navigator } from "../../../src/viewport/navigator/navigator";
import { distanceOf, poseFinite } from "../../../src/viewport/navigator/pose";
import { elevRange, minScaleOf } from "../../../src/viewport/navigator/limits";

function world(scale: number, r: () => number): BoxScene {
  const boxes: THREE.Box3[] = [];
  const n = 1 + Math.floor(r() * 3);
  const off = new THREE.Vector3((r() - 0.5) * 4, (r() - 0.5) * 4, r() * 2).multiplyScalar(scale);
  for (let i = 0; i < n; i++) {
    const c = new THREE.Vector3((r() - 0.5) * 3, (r() - 0.5) * 3, r()).multiplyScalar(scale).add(off);
    const h = new THREE.Vector3(r() + 0.1, r() + 0.1, r() + 0.1).multiplyScalar(scale * 0.5);
    boxes.push(new THREE.Box3(c.clone().sub(h), c.clone().add(h)));
  }
  return new BoxScene(boxes, r() < 0.5 ? off.z - scale : null);
}

describe("navigator fuzz", () => {
  it("10,000 random operations over scales 1e-3 to 1e6 stay finite and within limits", () => {
    const r = rng(20260924);
    let ops = 0;
    for (let run = 0; run < 20; run++) {
      const scale = 10 ** (-3 + r() * 9);
      const scene = world(scale, r);
      const nav = new Navigator();
      nav.setFrame(W, H);
      nav.setScene(scene);
      nav.setContentBox(scene.box());
      nav.opts.smoothTime = r() < 0.5 ? 0 : 0.125;
      const sphere = scene.box().getBoundingSphere(new THREE.Sphere());
      nav.resetView(sphere.center, sphere.radius, false);
      const px = () => r() * W;
      const py = () => r() * H;
      for (let i = 0; i < 500; i++, ops++) {
        const k = Math.floor(r() * 16);
        switch (k) {
          case 0: nav.wheel(px(), py(), (r() - 0.5) * 900, r() < 0.2); break;
          case 1: {
            nav.beginOrbit(px(), py());
            for (let j = 0; j < 5; j++) { nav.dragTo(px(), py(), r() * 0.05); nav.update(r() / 30); }
            if (r() < 0.5) nav.endGesture();
            break;
          }
          case 2: {
            nav.beginPan(px(), py());
            for (let j = 0; j < 5; j++) { nav.dragTo(px(), py()); nav.update(1 / 60); }
            nav.endGesture();
            break;
          }
          case 3: nav.zoomBy(Math.exp((r() - 0.5) * 4)); break;
          case 4: nav.panScreen((r() - 0.5) * 3, (r() - 0.5) * 3); break;
          case 5: nav.tumble((r() - 0.5) * 2, (r() - 0.5) * 2); break;
          case 6: nav.roll((r() - 0.5) * 3); break;
          case 7: nav.rotateTo(r() * 7 - 3.5, r() * 4 - 0.5, r() < 0.5); break;
          case 8: nav.setViewScale(10 ** (-6 + r() * 16), r() < 0.5); break;
          case 9: nav.fitSphere(sphere.center, sphere.radius, { animate: r() < 0.5 }); break;
          case 10: nav.setProjectionMode((["persp", "ortho", "auto"] as const)[Math.floor(r() * 3)]!); break;
          case 11: nav.restoreUp(r() < 0.5); break;
          case 12: nav.setFov(5 + r() * 100, r() < 0.5, r() < 0.5); break;
          case 13: {
            nav.beginPinch(px(), py());
            for (let j = 0; j < 4; j++) { nav.pinchTo(px(), py(), (r() - 0.5) * 2); nav.update(1 / 60); }
            nav.endGesture();
            break;
          }
          case 14: nav.lookAtPlane(sphere.center, new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), new THREE.Vector3(0, 0, 1), r() < 0.5); break;
          default: {
            const frames = 1 + Math.floor(r() * 20);
            for (let j = 0; j < frames; j++) nav.update(r() < 0.1 ? 0 : r() < 0.1 ? 0.5 : 1 / 60);
          }
        }
        nav.update(1 / 60);
        const p = nav.pose;
        const where = `run ${run} op ${i} kind ${k} scale ${scale}`;
        expect(poseFinite(p), where).toBe(true);
        expect(Number.isFinite(distanceOf(p)), where).toBe(true);
        expect(p.scale, where).toBeLessThanOrEqual(nav.limits.maxScale * (1 + 1e-9));
        expect(p.scale, where).toBeGreaterThanOrEqual(minScaleOf(nav.limits, p.fov) * (1 - 1e-9));
        if (p.level) {
          const [lo, hi] = elevRange(nav.limits);
          expect(p.elev, where).toBeGreaterThanOrEqual(lo - 1e-12);
          expect(p.elev, where).toBeLessThanOrEqual(hi + 1e-12);
          expect(Math.abs(new THREE.Vector3(1, 0, 0).applyQuaternion(p.q).z), where).toBeLessThan(1e-9);
        }
      }
    }
    expect(ops).toBe(10000);
  });
});
