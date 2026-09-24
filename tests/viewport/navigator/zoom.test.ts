// Wheel zoom: the point under the cursor stays under it on every eased frame,
// the camera never goes through the surface it zooms toward, and the anchor
// over empty space is never a far-off ground point.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  H, TAUS, W, eye, lineOfSightClear, maxDiff, pixel, probePoints, rng, screenPrint, settle, setup,
} from "./kit";
import { distanceOf } from "../../../src/viewport/navigator/pose";
import { zoomAnchor, PROBE_COUNT } from "../../../src/viewport/navigator/anchor";

const PX_TOL = 1e-9 * H;

describe("wheel zoom", () => {
  for (const tau of TAUS) {
    for (const ortho of [false, true]) {
      it(`keeps the anchor on its pixel every frame (tau ${tau}, ${ortho ? "ortho" : "persp"})`, () => {
        const { nav } = setup({ tau, ortho });
        const r = rng(7);
        for (let trial = 0; trial < 6; trial++) {
          const x = 200 + r() * 400;
          const y = 150 + r() * 300;
          const notches = trial % 2 ? 4 : -4;
          nav.wheel(x, y, notches * 100);
          nav.update(1 / 60);
          // The channel's anchor is resolved inside the first update; read it back
          // from what is under the cursor now.
          const a = zoomAnchor(nav.pose, { scene: null, plane: null, box: null, frame: nav.frame }, x, y);
          const anchor = (nav as unknown as { zooms: { anchor: THREE.Vector3 }[] }).zooms[0]?.anchor ?? a.point;
          for (let f = 0; f < 120 && nav.isBusy(); f++) {
            const s = pixel(nav, anchor);
            expect(Math.abs(s.x - x)).toBeLessThan(PX_TOL);
            expect(Math.abs(s.y - y)).toBeLessThan(PX_TOL);
            nav.update(1 / 60);
          }
          settle(nav);
          const s = pixel(nav, anchor);
          expect(Math.abs(s.x - x)).toBeLessThan(PX_TOL);
          expect(Math.abs(s.y - y)).toBeLessThan(PX_TOL);
        }
      });
    }

    it(`300 notches never pass the surface (tau ${tau})`, () => {
      const { nav, scene } = setup({ tau });
      const c = pixel(nav, new THREE.Vector3(5, -15, 10)); // on the front face
      for (let i = 0; i < 300; i++) {
        nav.wheel(c.x, c.y, -100);
        nav.update(1 / 60);
        const e = eye(nav);
        expect(scene.boxes[0]!.containsPoint(e)).toBe(false);
        expect(e.y).toBeLessThan(-15);
      }
      settle(nav);
      const e = eye(nav);
      const gap = -15 - e.y;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeGreaterThanOrEqual(nav.limits.minDistance * 0.5);
      expect(lineOfSightClear(scene, e, new THREE.Vector3(5, -15, 10))).toBe(true);
    });

    it(`in then out at one pixel returns to the start (tau ${tau})`, () => {
      const { nav, scene } = setup({ tau });
      const pts = probePoints(scene.box());
      const before = screenPrint(nav, pts);
      const e0 = eye(nav);
      const x = 420, y = 280;
      for (let i = 0; i < 10; i++) { nav.wheel(x, y, -100); nav.update(1 / 60); }
      settle(nav);
      for (let i = 0; i < 10; i++) { nav.wheel(x, y, 100); nav.update(1 / 60); }
      settle(nav);
      expect(maxDiff(before, screenPrint(nav, pts))).toBeLessThan(1e-6);
      expect(eye(nav).distanceTo(e0)).toBeLessThan(1e-6 * Math.max(1, e0.length()));
    });
  }

  it("lands on the same pose whatever the frame rate", () => {
    const poses: THREE.Vector3[] = [];
    for (const fps of [30, 60, 144]) {
      const { nav } = setup({ tau: 0.125 });
      nav.wheel(300, 250, -300);
      const dt = 1 / fps;
      // the same instant, 1/6 s in, at each rate
      for (let i = 0; i < fps / 6; i++) nav.update(dt);
      poses.push(eye(nav));
    }
    expect(poses[0]!.distanceTo(poses[1]!)).toBeLessThan(1e-6);
    expect(poses[1]!.distanceTo(poses[2]!)).toBeLessThan(1e-6);
  });

  it("over empty space anchors within two eye distances, never on a far ground point", () => {
    const { nav, scene } = setup({ ground: 0 });
    scene.boxes = [];
    nav.setContentBox(null);
    // look nearly level so the ground under the top of the screen is far away
    nav.rotateTo(0.3, Math.PI / 2 - 0.02);
    settle(nav);
    const d = distanceOf(nav.pose);
    const a = zoomAnchor(nav.pose, { scene, plane: null, box: null, frame: nav.frame }, W / 2, 10);
    expect(a.depth).toBeLessThanOrEqual(2 * d + 1e-9);
  });

  it("casts at most 17 rays into the scene per anchor", () => {
    const { nav, scene } = setup();
    scene.rays = 0;
    zoomAnchor(nav.pose, { scene, plane: null, box: nav.contentBox(), frame: nav.frame }, 5, 5);
    expect(PROBE_COUNT).toBe(16);
    expect(scene.rays).toBeLessThanOrEqual(17);
  });

  it("re-seats the target at the anchor's depth", () => {
    const { nav } = setup();
    const onFace = new THREE.Vector3(-5, -15, 5);
    const c = pixel(nav, onFace);
    nav.wheel(c.x, c.y, -100);
    settle(nav);
    // After the zoom settles the target sits on the surface at the centre of
    // the screen: the box's front face, not its middle.
    const t = nav.pose.target;
    expect(Math.abs(t.y + 15) < 1e-6 || Math.abs(t.z - 20) < 1e-6 || Math.abs(t.x - 20) < 1e-6).toBe(true);
  });

  for (const inertia of [false, true]) {
    it(`a wheel right after an orbit release stops the turn, so its anchor stays pinned (inertia ${inertia})`, () => {
      const { nav } = setup({ tau: 0.125 });
      nav.opts.inertia = inertia;
      const x = 380, y = 320;
      nav.beginOrbit(x, y);
      for (let i = 1; i <= 8; i++) { nav.dragTo(x + i * 25, y, 0.008); nav.update(1 / 120); }
      nav.endGesture();
      nav.wheel(x + 200, y, -100);
      nav.update(1 / 60);
      const anchor = (nav as unknown as { zooms: { anchor: THREE.Vector3 }[] }).zooms[0]!.anchor.clone();
      for (let f = 0; f < 200 && nav.isBusy(); f++) {
        const s = pixel(nav, anchor);
        expect(Math.hypot(s.x - (x + 200), s.y - y)).toBeLessThan(PX_TOL);
        nav.update(1 / 60);
      }
    });
  }
});
