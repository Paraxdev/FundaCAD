// The 3D mouse and touch: the mouse's turntable re-levels a view the 3D mouse
// banked, the 3D mouse zoom can never go through a surface, and a pinch zooms
// about its midpoint.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { H, TAUS, eye, fwd, lineOfSightClear, pixel, rightZ, settle, setup } from "./kit";

describe("re-level after a 3D mouse roll", () => {
  for (const tau of TAUS) {
    it(`comes back level over the first ${80} px of the next orbit, pivot pinned (tau ${tau})`, () => {
      const { nav } = setup({ tau });
      nav.roll(0.6);
      nav.tumble(0.3, 0.2);
      expect(nav.pose.level).toBe(false);
      const pivot = nav.pivotAt(400, 300);
      const p0 = pixel(nav, pivot);
      nav.beginOrbit(400, 300);
      for (let i = 1; i <= 10; i++) {
        nav.dragTo(400 + i * 10, 300);
        nav.update(1 / 60);
        const s = pixel(nav, pivot);
        expect(Math.hypot(s.x - p0.x, s.y - p0.y)).toBeLessThan(1e-9 * H);
      }
      nav.endGesture();
      settle(nav);
      expect(nav.pose.level).toBe(true);
      expect(Math.abs(rightZ(nav))).toBeLessThan(1e-12);
      const s = pixel(nav, pivot);
      expect(Math.hypot(s.x - p0.x, s.y - p0.y)).toBeLessThan(1e-9 * H);
    });
  }

  it("the roll comes off in proportion to the drag, not all at once", () => {
    const { nav } = setup({ tau: 0 });
    nav.roll(0.8);
    nav.beginOrbit(400, 300);
    nav.dragTo(420, 300);
    nav.update(1 / 60);
    const r = new THREE.Vector3(1, 0, 0).applyQuaternion(nav.pose.q);
    // a quarter of the way through the re-level
    expect(Math.abs(r.z)).toBeGreaterThan(0.3);
    nav.endGesture();
  });
});

describe("3D mouse", () => {
  it("zoom about the centre never passes through the surface there", () => {
    const { nav, scene } = setup();
    nav.setLookAt(new THREE.Vector3(0, -200, 10), new THREE.Vector3(0, 0, 10));
    for (let i = 0; i < 2000; i++) {
      nav.zoomBy(0.97);
      const e = eye(nav);
      expect(scene.boxes[0]!.containsPoint(e)).toBe(false);
      expect(e.y).toBeLessThan(-15);
    }
    expect(lineOfSightClear(scene, eye(nav), new THREE.Vector3(0, -15, 10))).toBe(true);
    // and it can back out again
    for (let i = 0; i < 120; i++) nav.zoomBy(1.1);
    expect(eye(nav).y).toBeLessThan(-20);
  });

  it("panScreen moves by half view heights at the surface depth", () => {
    const { nav } = setup();
    nav.setLookAt(new THREE.Vector3(0, -200, 10), new THREE.Vector3(0, 0, 10));
    const onFace = new THREE.Vector3(0, -15, 10);
    const before = pixel(nav, onFace);
    nav.panScreen(0.1, 0);
    const after = pixel(nav, onFace);
    // 0.1 half heights is 0.05 of the viewport height, at the surface's depth
    expect(before.x - after.x).toBeCloseTo(0.05 * H, 6);
  });

  it("tumble goes over the pole, which the mouse orbit never does", () => {
    const { nav } = setup();
    for (let i = 0; i < 40; i++) nav.tumble(0, -0.1);
    expect(nav.pose.level).toBe(false);
    expect(Number.isFinite(fwd(nav).z)).toBe(true);
  });
});

describe("touch", () => {
  it("a pinch zooms about the midpoint and carries it with the fingers", () => {
    const { nav } = setup({ tau: 0.125 });
    const mid = new THREE.Vector3(3, -15, 12);
    const m = pixel(nav, mid);
    nav.beginPinch(m.x, m.y);
    for (let i = 1; i <= 10; i++) {
      nav.pinchTo(m.x + i * 3, m.y, Math.log(1 / 1.05));
      nav.update(1 / 60);
    }
    nav.endGesture();
    settle(nav);
    const s = pixel(nav, mid);
    expect(Math.hypot(s.x - (m.x + 30), s.y - m.y)).toBeLessThan(1e-6);
  });

  it("a pinch still zooms when frames pass between the fingers landing and spreading", () => {
    const { nav } = setup({ tau: 0.125 });
    const mid = new THREE.Vector3(3, -15, 12);
    const m = pixel(nav, mid);
    const d0 = eye(nav).distanceTo(mid);
    nav.beginPinch(m.x, m.y);
    for (let i = 0; i < 3; i++) nav.update(1 / 60);
    for (let i = 1; i <= 10; i++) {
      nav.pinchTo(m.x, m.y, Math.log(1 / 1.05));
      nav.update(1 / 60);
    }
    nav.endGesture();
    settle(nav);
    expect(eye(nav).distanceTo(mid) / d0).toBeCloseTo(1 / 1.05 ** 10, 6);
    const s = pixel(nav, mid);
    expect(Math.hypot(s.x - m.x, s.y - m.y)).toBeLessThan(1e-6);
  });
});
