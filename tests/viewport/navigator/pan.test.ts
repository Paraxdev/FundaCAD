// Pan is 1:1: the point grabbed ends exactly under the cursor, in perspective
// and orthographic alike (orthographic used to run at twice the cursor).
// Swapping projections keeps the scale, and re-seating the target never moves
// anything on screen.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  TAUS, UNIT_BOX, eye, lineOfSightClear, maxDiff, pixel, probePoints, screenPrint, settle, setup,
} from "./kit";
import { depthOf, distanceOf } from "../../../src/viewport/navigator/pose";
import { zoomAnchor } from "../../../src/viewport/navigator/anchor";

describe("pan", () => {
  for (const tau of TAUS) {
    for (const ortho of [false, true]) {
      for (const [x0, y0] of [[400, 300], [60, 40]] as const) {
        it(`is 1:1 (tau ${tau}, ${ortho ? "ortho" : "persp"}, grab at ${x0},${y0})`, () => {
          const { nav, scene } = setup({ tau, ortho });
          const grab = zoomAnchor(nav.pose, { scene, plane: null, box: nav.contentBox(), frame: nav.frame }, x0, y0).point;
          nav.beginPan(x0, y0);
          const moves: [number, number][] = [[30, 5], [80, -20], [140, 60], [133, 71]];
          for (const [x, y] of moves) {
            nav.dragTo(x0 + x, y0 + y);
            nav.update(1 / 60);
          }
          nav.endGesture();
          settle(nav);
          const s = pixel(nav, grab);
          expect(Math.abs(s.x - (x0 + 133))).toBeLessThan(1e-6);
          expect(Math.abs(s.y - (y0 + 71))).toBeLessThan(1e-6);
        });
      }
    }
  }

  it("stays 1:1 when the wheel turns mid-pan", () => {
    const { nav, scene } = setup({ tau: 0.125 });
    const grab = zoomAnchor(nav.pose, { scene, plane: null, box: nav.contentBox(), frame: nav.frame }, 400, 300).point;
    nav.beginPan(400, 300);
    nav.dragTo(450, 320);
    nav.update(1 / 60);
    nav.wheel(450, 320, -300);
    for (let i = 0; i < 10; i++) nav.update(1 / 60);
    nav.dragTo(470, 330);
    nav.endGesture();
    settle(nav);
    const s = pixel(nav, grab);
    expect(Math.hypot(s.x - 470, s.y - 330)).toBeLessThan(1e-6);
  });
});

describe("projection", () => {
  it("a swap keeps the scale: what is at the target keeps its pixels", () => {
    const { nav } = setup();
    nav.setProjectionMode("persp");
    settle(nav);
    const t = nav.pose.target.clone();
    const pts = [t, t.clone().add(new THREE.Vector3(3, 0, 0)), t.clone().add(new THREE.Vector3(0, 0, 4))];
    // points ON the target's depth plane project the same in both
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(nav.pose.q);
    const onPlane = pts.map((p) => p.clone().addScaledVector(f, -f.dot(p.clone().sub(t))));
    const before = screenPrint(nav, onPlane);
    nav.setProjectionMode("ortho");
    expect(maxDiff(before, screenPrint(nav, onPlane))).toBeLessThan(1e-9);
    nav.setProjectionMode("persp");
    expect(maxDiff(before, screenPrint(nav, onPlane))).toBeLessThan(1e-9);
  });

  it("an orthographic zoom then perspective keeps the model in front of the eye", () => {
    const { nav, scene } = setup({ ortho: true });
    const onTop = new THREE.Vector3(3, 2, 20);
    const c = pixel(nav, onTop);
    for (let i = 0; i < 60; i++) { nav.wheel(c.x, c.y, -100); nav.update(1 / 60); }
    settle(nav);
    nav.setProjectionMode("persp");
    settle(nav);
    const e = eye(nav);
    expect(scene.boxes[0]!.containsPoint(e)).toBe(false);
    expect(depthOf(nav.pose, onTop)).toBeGreaterThan(0);
    expect(lineOfSightClear(scene, e, onTop)).toBe(true);
  });
});

describe("re-seat and containment", () => {
  it("re-seating onto the centre surface leaves the screen as it was", () => {
    for (const ortho of [false, true]) {
      const { nav } = setup({ ortho });
      const pts = probePoints(UNIT_BOX);
      const before = screenPrint(nav, pts);
      nav.reseatAndContain();
      nav.update(1 / 60);
      expect(maxDiff(before, screenPrint(nav, pts))).toBeLessThan(1e-9);
    }
  });

  it("zooming out over empty space keeps the target inside the model ball, screen unchanged", () => {
    const { nav } = setup({ tau: 0 });
    const ball = UNIT_BOX.getBoundingSphere(new THREE.Sphere());
    for (let i = 0; i < 30; i++) {
      nav.wheel(790, 10, 200);
      nav.update(1 / 60);
    }
    // everything has settled and been contained; containing again moves nothing
    const pts = probePoints(UNIT_BOX);
    const before = screenPrint(nav, pts);
    settle(nav);
    nav.reseatAndContain();
    nav.update(1 / 60);
    expect(maxDiff(before, screenPrint(nav, pts))).toBeLessThan(1e-9);
    // Along the view axis only: inside the ball when the axis passes through
    // it, else the axis point nearest the model.
    const axis = new THREE.Ray(eye(nav), new THREE.Vector3(0, 0, -1).applyQuaternion(nav.pose.q));
    const off = axis.distanceToPoint(ball.center);
    const allowed = off < ball.radius * 1.5 ? ball.radius * 1.5 : off;
    expect(nav.pose.target.distanceTo(ball.center)).toBeLessThanOrEqual(allowed * (1 + 1e-9) + 1e-6);
    expect(distanceOf(nav.pose)).toBeGreaterThan(0);
  });
});
