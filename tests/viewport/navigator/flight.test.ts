// Flights land exactly on their destination, a soft one gives way to input
// where it stands, a hard one (sketch entry) takes no input until it lands, and
// the programmatic API matches what it says.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { eye, fwd, pixel, rightZ, settle, setup } from "./kit";
import { clonePose, distanceOf, halfTan, makePose, copyPose } from "../../../src/viewport/navigator/pose";
import { lookQuatUp } from "../../../src/viewport/navigator/navigator";

describe("flights", () => {
  it("land exactly and keep the horizon level between level ends", () => {
    const { nav } = setup();
    const to = nav.poseWith(lookQuatUp(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)), new THREE.Vector3(5, 5, 5), 12);
    nav.flyTo(to, { animate: true });
    let frames = 0;
    while (nav.isFlying()) {
      nav.update(1 / 60);
      frames++;
      expect(Math.abs(rightZ(nav))).toBeLessThan(1e-12);
    }
    expect(frames).toBeGreaterThan(5);
    expect(nav.pose.q.angleTo(to.q)).toBe(0);
    expect(nav.pose.target.equals(to.target)).toBe(true);
    expect(nav.pose.scale).toBe(12);
    expect(nav.pose.elev).toBe(0);
  });

  it("a soft flight cancelled by input stops at the frame on screen", () => {
    const { nav } = setup({ tau: 0 });
    nav.rotateTo(1.2, 0.4, true);
    for (let i = 0; i < 6; i++) nav.update(1 / 60);
    expect(nav.isFlying()).toBe(true);
    const mid = copyPose(makePose(), nav.pose);
    nav.beginOrbit(400, 300);
    expect(nav.isFlying()).toBe(false);
    nav.update(1 / 60);
    expect(nav.pose.q.angleTo(mid.q)).toBeLessThan(1e-12);
    expect(eye(nav).distanceTo(new THREE.Vector3().copy(mid.target).addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(mid.q), -distanceOf(mid)))).toBeLessThan(1e-9);
  });

  it("a hard flight ignores input and lands where it was going", () => {
    const { nav } = setup({ tau: 0 });
    let arrived = 0;
    const origin = new THREE.Vector3(0, 0, 20);
    nav.lookAtPlane(origin, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), true, () => arrived++);
    nav.update(1 / 60);
    nav.beginOrbit(400, 300);
    nav.dragTo(460, 330);
    nav.wheel(400, 300, -500);
    while (nav.isFlying()) nav.update(1 / 60);
    expect(arrived).toBe(1);
    const f = fwd(nav);
    expect(f.z).toBeCloseTo(-1, 15);
    expect(nav.pose.target.equals(origin)).toBe(true);
  });

  it("entering a sketch keeps the current scale", () => {
    const { nav } = setup();
    const s = nav.pose.scale;
    nav.lookAtPlane(new THREE.Vector3(0, -15, 10), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), false);
    expect(nav.pose.scale).toBe(s);
  });

  it("restoreUp flies back to a level horizon with the same view direction", () => {
    const { nav } = setup();
    nav.roll(0.4);
    expect(nav.pose.level).toBe(false);
    const f0 = fwd(nav);
    nav.restoreUp(false);
    expect(nav.pose.level).toBe(true);
    expect(Math.abs(rightZ(nav))).toBeLessThan(1e-12);
    expect(fwd(nav).angleTo(f0)).toBeLessThan(1e-9);
  });
});

describe("programmatic API", () => {
  it("setLookAt, rotateTo, moveTo, setViewScale do what they say", () => {
    const { nav } = setup();
    const e = new THREE.Vector3(100, -100, 50);
    const t = new THREE.Vector3(1, 2, 3);
    nav.setLookAt(e, t);
    expect(eye(nav).distanceTo(e)).toBeLessThan(1e-9);
    expect(nav.pose.target.distanceTo(t)).toBeLessThan(1e-12);
    nav.rotateTo(Math.PI / 2, Math.PI / 2);
    // azimuth 90 degrees looks in from +X
    expect(fwd(nav).x).toBeCloseTo(-1, 12);
    nav.moveTo(new THREE.Vector3(9, 9, 9));
    expect(nav.pose.target.toArray()).toEqual([9, 9, 9]);
    nav.setViewScale(7);
    expect(nav.pose.scale).toBe(7);
  });

  it("fitSphere frames the ball in both directions", () => {
    const { nav } = setup();
    nav.fitSphere(new THREE.Vector3(0, 0, 0), 10, { padding: 1 });
    const d = distanceOf(nav.pose);
    const vHalf = Math.atan(halfTan(nav.pose.fov));
    expect(d * Math.sin(vHalf)).toBeGreaterThanOrEqual(10 - 1e-9);
  });

  it("setOrbitPoint turns later orbits about it without moving the screen", () => {
    const { nav } = setup({ tau: 0 });
    const p = new THREE.Vector3(20, -15, 20);
    const before = pixel(nav, p);
    nav.setOrbitPoint(p);
    const mid = pixel(nav, p);
    expect(Math.hypot(mid.x - before.x, mid.y - before.y)).toBeLessThan(1e-9);
    nav.orbitBy(0.7, 0.2);
    const after = pixel(nav, p);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1e-9);
  });

  it("a dolly zoom keeps the subject's size while the lens changes", () => {
    const { nav } = setup();
    const t = nav.pose.target.clone();
    const side = t.clone().add(new THREE.Vector3(10, 0, 0).applyQuaternion(nav.pose.q));
    const w0 = pixel(nav, side).x - pixel(nav, t).x;
    const d0 = distanceOf(nav.pose);
    nav.setFov(20, true, true);
    for (let i = 0; i < 5; i++) {
      nav.update(1 / 60);
      const w = pixel(nav, side).x - pixel(nav, t).x;
      expect(Math.abs(w - w0)).toBeLessThan(1e-6);
    }
    settle(nav);
    expect(nav.pose.fov).toBe(20);
    expect(distanceOf(nav.pose)).toBeGreaterThan(d0 * 2);
    // without keepScale the eye holds still
    const e = eye(nav);
    nav.setFov(60, false, false);
    expect(eye(nav).distanceTo(e)).toBeLessThan(1e-9);
  });

  it("getState-style copies round trip", () => {
    const { nav } = setup();
    const saved = clonePose(nav.pose);
    nav.rotateTo(2, 1);
    nav.flyTo(saved);
    expect(nav.pose.q.angleTo(saved.q)).toBe(0);
    expect(nav.pose.target.equals(saved.target)).toBe(true);
  });
});
