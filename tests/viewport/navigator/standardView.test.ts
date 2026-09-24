// A view cube click or standard view while zoomed in deep turns about the detail
// on screen and keeps its size. It used to pivot at the depth of the model's
// centre, so on the 40 mm box the half height jumped from 0.078 mm to 2.1 mm and
// the detail left the screen.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { H, TAUS, UNIT_BOX, W, pixel, settle, setup } from "./kit";
import { lookQuatUp, type Navigator } from "../../../src/viewport/navigator/navigator";
import { boxOffScreen, makePose, setOrientation } from "../../../src/viewport/navigator/pose";

const view = (dir: [number, number, number], up: [number, number, number]) =>
  lookQuatUp(new THREE.Vector3(...dir).normalize(), new THREE.Vector3(...up));
const TOP = view([0, 0, 1], [0, 1, 0]);
const FRONT = view([0, -1, 0], [0, 0, 1]);
const ISO = view([1, -1, 0.8], [0, 0, 1]);

/** Just inside the top face's front right corner. */
const DETAIL = new THREE.Vector3(19.95, -14.95, 20);

function zoomedIn(tau: number, ortho: boolean): Navigator {
  const { nav } = setup({ tau, ortho });
  nav.moveTo(DETAIL);
  for (let i = 0; i < 40; i++) {
    nav.wheel(W / 2, H / 2, -100);
    nav.update(1 / 60);
  }
  settle(nav);
  expect(nav.pose.scale).toBeLessThan(0.1);
  return nav;
}

function expectDetailCentred(nav: Navigator) {
  const s = pixel(nav, DETAIL);
  expect(Math.abs(s.x - W / 2)).toBeLessThan(1e-6);
  expect(Math.abs(s.y - H / 2)).toBeLessThan(1e-6);
}

describe("standard views while zoomed in deep", () => {
  for (const tau of TAUS) {
    for (const ortho of [false, true]) {
      const label = `tau ${tau}, ${ortho ? "ortho" : "persp"}`;

      it(`Top keeps the scale and the detail at the centre (${label})`, () => {
        const nav = zoomedIn(tau, ortho);
        const s = nav.pose.scale;
        expectDetailCentred(nav);
        nav.turnTo(TOP, true);
        settle(nav);
        expect(nav.pose.q.angleTo(TOP)).toBeLessThan(1e-9);
        expect(nav.pose.scale / s).toBeCloseTo(1, 12);
        expectDetailCentred(nav);
      });

      it(`iso, front then top keep the scale (${label})`, () => {
        const nav = zoomedIn(tau, ortho);
        const s = nav.pose.scale;
        for (const q of [ISO, FRONT, TOP]) {
          nav.turnTo(q, true);
          settle(nav);
          expect(nav.pose.scale / s).toBeCloseTo(1, 12);
          expectDetailCentred(nav);
        }
      });
    }
  }

  it("keeps the scale in auto projection, which goes orthographic on an axis", () => {
    const { nav } = setup({ tau: 0 });
    nav.setProjectionMode("auto");
    nav.moveTo(DETAIL);
    for (let i = 0; i < 40; i++) { nav.wheel(W / 2, H / 2, -100); nav.update(1 / 60); }
    settle(nav);
    const s = nav.pose.scale;
    for (const q of [TOP, FRONT, ISO]) {
      nav.turnTo(q, false);
      settle(nav);
      expect(nav.pose.scale / s).toBeCloseTo(1, 12);
      expectDetailCentred(nav);
    }
    nav.turnTo(TOP, false);
    settle(nav);
    expect(nav.pose.ortho).toBe(true);
  });

  it("a view the model would be wholly off screen in frames the model instead", () => {
    const { nav } = setup({ tau: 0 });
    const aside = makePose();
    setOrientation(aside, FRONT);
    aside.target.set(70, 0, 10);
    aside.scale = 2;
    nav.flyTo(aside);
    nav.turnTo(TOP, false);
    settle(nav);
    expect(nav.pose.q.angleTo(TOP)).toBeLessThan(1e-9);
    expect(boxOffScreen(nav.pose, nav.frame, UNIT_BOX)).toBe(false);
    const sphere = UNIT_BOX.getBoundingSphere(new THREE.Sphere());
    expect(nav.pose.target.distanceTo(sphere.center)).toBeLessThan(1e-9);
    // every corner inside the frame
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? UNIT_BOX.max.x : UNIT_BOX.min.x, i & 2 ? UNIT_BOX.max.y : UNIT_BOX.min.y, i & 4 ? UNIT_BOX.max.z : UNIT_BOX.min.z);
      const p = pixel(nav, c);
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(W);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(H);
    }
  });
});

describe("boxOffScreen", () => {
  it("tells a box beside the view from one in it, or one behind the eye", () => {
    const p = makePose();
    setOrientation(p, FRONT);
    p.scale = 10;
    const frame = { width: W, height: H };
    const box = (x: number, y: number) => new THREE.Box3(new THREE.Vector3(x - 1, y - 1, -1), new THREE.Vector3(x + 1, y + 1, 1));
    expect(boxOffScreen(p, frame, box(0, 0))).toBe(false);
    expect(boxOffScreen(p, frame, box(40, 0))).toBe(true);
    expect(boxOffScreen(p, frame, box(0, -200))).toBe(true);
    // straddling the left edge
    expect(boxOffScreen(p, frame, box(-13.8, 0))).toBe(false);
    p.ortho = true;
    expect(boxOffScreen(p, frame, box(0, -200))).toBe(false);
    expect(boxOffScreen(p, frame, box(40, 0))).toBe(true);
  });
});
