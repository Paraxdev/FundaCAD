// Arrow-key view steps and the orbit pivot preference, on the headless navigator.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { fwd, pixel, settle, setup } from "./kit";
import { VIEW_STEP, VIEW_STEP_FINE, stepAngles } from "../../../src/viewport/navigator/navigator";

const deg = (r: number) => (r * 180) / Math.PI;

describe("stepView", () => {
  it("steps 15 degrees, a fine step 5", () => {
    expect(deg(VIEW_STEP)).toBeCloseTo(15, 9);
    expect(deg(VIEW_STEP_FINE)).toBeCloseTo(5, 9);
    expect(stepAngles("left", false)).toEqual([VIEW_STEP, 0]);
    expect(stepAngles("right", true)).toEqual([-VIEW_STEP_FINE, 0]);
    expect(stepAngles("up", false)).toEqual([0, VIEW_STEP]);
    expect(stepAngles("down", false)).toEqual([0, -VIEW_STEP]);
  });

  it("right and left turn about the up axis and keep the horizon level", () => {
    const { nav } = setup({ tau: 0 });
    const t = nav.pose.target.clone();
    const near = t.clone().addScaledVector(fwd(nav), -10);
    const before = pixel(nav, near).x;
    nav.stepView("right");
    settle(nav);
    expect(pixel(nav, near).x).toBeGreaterThan(before);
    expect(nav.pose.level).toBe(true);
    nav.stepView("left");
    nav.stepView("left");
    settle(nav);
    expect(pixel(nav, near).x).toBeLessThan(before);
  });

  it("up and down tilt, and 24 right steps come back round", () => {
    const { nav } = setup({ tau: 0 });
    const near = nav.pose.target.clone().addScaledVector(fwd(nav), -10);
    const before = pixel(nav, near).y;
    nav.stepView("up");
    expect(pixel(nav, near).y).toBeLessThan(before);
    nav.stepView("down");
    expect(pixel(nav, near).y).toBeCloseTo(before, 6);
    const q0 = nav.pose.q.clone();
    for (let i = 0; i < 24; i++) nav.stepView("right");
    expect(nav.pose.q.angleTo(q0)).toBeLessThan(1e-9);
  });
});

describe("preferred pivot", () => {
  it("origin turns a drag about the origin, selection about its centre, auto about the model", () => {
    const { nav } = setup({ tau: 0 });
    const origin = new THREE.Vector3(0, 0, 0);
    const centre = new THREE.Vector3(30, 40, 5);
    const fixed = (p: THREE.Vector3) => {
      const before = pixel(nav, p);
      nav.beginOrbit(400, 300);
      nav.dragTo(520, 330);
      nav.endGesture(true);
      settle(nav);
      const after = pixel(nav, p);
      return Math.hypot(after.x - before.x, after.y - before.y);
    };
    nav.opts.preferredPivot = () => origin;
    expect(fixed(origin)).toBeLessThan(1e-6);
    nav.opts.preferredPivot = () => centre;
    expect(fixed(centre)).toBeLessThan(1e-6);
    nav.opts.preferredPivot = () => null;
    expect(fixed(origin)).toBeGreaterThan(1e-3);
  });

  it("the arrow steps turn about it too", () => {
    const { nav } = setup({ tau: 0 });
    const centre = new THREE.Vector3(30, 40, 5);
    nav.opts.preferredPivot = () => centre;
    const before = pixel(nav, centre);
    nav.stepView("right");
    const after = pixel(nav, centre);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1e-6);
  });
});
