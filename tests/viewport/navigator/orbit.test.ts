// Mouse orbit: a turntable about the point under the press. That point keeps its
// pixel on every frame, the horizon never rolls, Top is exact, and the eased
// drag ends on the pose the raw drag would have.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { H, TAUS, eye, fwd, pixel, rightZ, rng, settle, setup } from "./kit";
import { copyPose, makePose } from "../../../src/viewport/navigator/pose";

const PX_TOL = 1e-9 * H;

function drag(nav: ReturnType<typeof setup>["nav"], x0: number, y0: number, path: [number, number][], each?: () => void) {
  nav.beginOrbit(x0, y0);
  let x = x0, y = y0;
  for (const [dx, dy] of path) {
    x += dx; y += dy;
    nav.dragTo(x, y);
    nav.update(1 / 60);
    each?.();
  }
  nav.endGesture();
}

describe("mouse orbit", () => {
  for (const tau of TAUS) {
    for (const ortho of [false, true]) {
      it(`keeps the pivot on its pixel every frame, horizon level (tau ${tau}, ${ortho ? "ortho" : "persp"})`, () => {
        const { nav } = setup({ tau, ortho });
        nav.setProjectionMode(ortho ? "ortho" : "persp");
        const r = rng(11);
        for (let trial = 0; trial < 5; trial++) {
          const x0 = 250 + r() * 300;
          const y0 = 200 + r() * 200;
          const pivot = nav.pivotAt(x0, y0);
          const p0 = pixel(nav, pivot);
          const path: [number, number][] = [];
          for (let i = 0; i < 20; i++) path.push([(r() - 0.5) * 30, (r() - 0.5) * 30]);
          const check = () => {
            const s = pixel(nav, pivot);
            expect(Math.abs(s.x - p0.x)).toBeLessThan(PX_TOL);
            expect(Math.abs(s.y - p0.y)).toBeLessThan(PX_TOL);
            expect(Math.abs(rightZ(nav))).toBeLessThan(1e-12);
          };
          drag(nav, x0, y0, path, check);
          for (let f = 0; f < 200 && nav.isBusy(); f++) { nav.update(1 / 60); check(); }
          settle(nav);
        }
      });
    }

    it(`reaches Top exactly and leaves it smoothly (tau ${tau})`, () => {
      const { nav } = setup({ tau });
      // a long drag down takes the camera up and over, clamped at straight down
      drag(nav, 400, 300, Array.from({ length: 40 }, () => [0, 20] as [number, number]));
      settle(nav);
      expect(nav.pose.elev).toBe(0);
      const f = fwd(nav);
      expect(Math.abs(f.x)).toBe(0);
      expect(Math.abs(f.y)).toBe(0);
      expect(Math.abs(f.z + 1)).toBeLessThan(1e-15);
      // now leave the pole a pixel at a time: each frame moves the view
      // direction by about the drag, with no flip
      let prev = fwd(nav);
      drag(nav, 400, 300, Array.from({ length: 30 }, () => [0, -1] as [number, number]), () => {
        const now = fwd(nav);
        const step = now.angleTo(prev);
        expect(step).toBeLessThan((2 * Math.PI) / H * 1.01 + 1e-12);
        prev = now;
        expect(Math.abs(rightZ(nav))).toBeLessThan(1e-12);
      });
    });
  }

  it("the eased drag ends on the raw drag's pose", () => {
    const r = rng(3);
    const path: [number, number][] = Array.from({ length: 30 }, () => [(r() - 0.5) * 40, (r() - 0.5) * 40]);
    const ends = TAUS.map((tau) => {
      const { nav } = setup({ tau });
      drag(nav, 410, 290, path);
      settle(nav);
      return copyPose(makePose(), nav.pose);
    });
    expect(ends[0]!.q.angleTo(ends[1]!.q)).toBeLessThan(1e-9);
    expect(ends[0]!.target.distanceTo(ends[1]!.target)).toBeLessThan(1e-6);
    expect(Math.abs(ends[0]!.scale - ends[1]!.scale)).toBeLessThan(1e-6);
  });

  it("drag right turns the model the way it is dragged", () => {
    const { nav } = setup({ tau: 0 });
    const onModel = nav.pivotAt(400, 300);
    const other = onModel.clone().add(new THREE.Vector3(0, -15, 0));
    const before = pixel(nav, other).x - pixel(nav, onModel).x;
    drag(nav, 400, 300, [[30, 0]]);
    const after = pixel(nav, other).x - pixel(nav, onModel).x;
    expect(after).toBeGreaterThan(before);
  });

  it("orbit lock turns a right drag into a pan", () => {
    const { nav } = setup({ tau: 0 });
    nav.setOrbitLocked(true);
    const q0 = nav.pose.q.clone();
    const e0 = eye(nav);
    drag(nav, 400, 300, [[20, 5]]);
    settle(nav);
    expect(nav.pose.q.angleTo(q0)).toBe(0);
    expect(eye(nav).distanceTo(e0)).toBeGreaterThan(0);
  });

  it("switches auto ortho to perspective when the turn starts, never mid-drag", () => {
    const { nav } = setup({ tau: 0.125 });
    nav.setProjectionMode("auto");
    nav.rotateTo(0, 0);
    settle(nav);
    expect(nav.pose.ortho).toBe(true);
    // a press alone may be a right click for the menu
    nav.beginOrbit(400, 300);
    nav.update(1 / 60);
    expect(nav.pose.ortho).toBe(true);
    // drag straight back up to the pole: still perspective while held
    nav.dragTo(400, 280);
    expect(nav.pose.ortho).toBe(false);
    nav.update(1 / 60);
    nav.dragTo(400, 320);
    for (let i = 0; i < 120; i++) nav.update(1 / 60);
    expect(nav.pose.elev).toBe(0);
    expect(nav.pose.ortho).toBe(false);
    nav.endGesture();
    settle(nav);
    expect(nav.pose.ortho).toBe(true);
  });

  it("inertia, when on, carries on about the same pivot", () => {
    const { nav } = setup({ tau: 0.125 });
    nav.opts.inertia = true;
    const pivot = nav.pivotAt(400, 300);
    const p0 = pixel(nav, pivot);
    nav.beginOrbit(400, 300);
    for (let i = 1; i <= 5; i++) { nav.dragTo(400 + i * 10, 300); nav.update(1 / 60); }
    const yawAtRelease = nav.pose.yaw;
    nav.endGesture();
    settle(nav);
    expect(nav.pose.yaw).toBeLessThan(yawAtRelease - 0.3);
    const s = pixel(nav, pivot);
    expect(Math.hypot(s.x - p0.x, s.y - p0.y)).toBeLessThan(1e-6);
  });
});
