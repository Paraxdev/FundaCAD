// 'auto' projection stays in perspective while the eye is inside the content box, in the default navigator.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Navigator } from "../../src/viewport/navigator/navigator";
import { createNavigatorRig } from "../../src/viewport/navigator/rig";
import { autoWantsOrtho, EDGE_HYSTERESIS, onWorldAxis } from "../../src/viewport/autoProjection";
import { autoProjectionCases } from "./autoProjectionCases";

describe("auto projection, default navigator", () => {
  autoProjectionCases(() => {
    const dom = document.createElement("canvas");
    const rig = createNavigatorRig(dom, 4 / 3);
    rig.resize(800, 600);
    return rig;
  });
});

describe("autoWantsOrtho", () => {
  const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const dir = new THREE.Vector3(0, 5, 0);

  it("sees a world axis within half a degree", () => {
    expect(onWorldAxis(0, 1, 0.008)).toBe(true);
    expect(onWorldAxis(0, 1, 0.01)).toBe(false);
    expect(onWorldAxis(0, 0, 0)).toBe(false);
  });

  it("is orthographic outside, perspective inside and on the edge", () => {
    expect(autoWantsOrtho(dir, new THREE.Vector3(0, -5, 0), box, false)).toBe(true);
    expect(autoWantsOrtho(dir, new THREE.Vector3(0, -0.5, 0), box, true)).toBe(false);
    expect(autoWantsOrtho(dir, new THREE.Vector3(0, -1, 0), box, true)).toBe(false);
  });

  it("holds the projection inside the hysteresis band", () => {
    const band = new THREE.Vector3(0, -1 - 0.5 * EDGE_HYSTERESIS * Math.sqrt(12), 0);
    expect(autoWantsOrtho(dir, band, box, true)).toBe(true);
    expect(autoWantsOrtho(dir, band, box, false)).toBe(false);
  });

  it("snaps from just outside when the target is close, as in a deep zoom", () => {
    const close = new THREE.Vector3(0, 0.01, 0);
    expect(autoWantsOrtho(close, new THREE.Vector3(0, -1.005, 0), box, false)).toBe(true);
  });
});

describe("auto projection, an orthographic view has no real eye", () => {
  const room = new THREE.Box3(new THREE.Vector3(-100, -100, -100), new THREE.Vector3(100, 100, 100));
  const settle = (nav: Navigator) => {
    for (let i = 0; i < 90; i++) nav.update(1 / 60);
  };
  const frontView = (box: THREE.Box3) => {
    const nav = new Navigator();
    nav.setFrame(800, 600);
    nav.setContentBox(box);
    nav.setProjectionMode("auto");
    nav.setLookAt(new THREE.Vector3(0, -1500, 0), new THREE.Vector3(0, 0, 0));
    settle(nav);
    return nav;
  };

  it("a wheel zooming in on a pocket floor deep in the box stays orthographic", () => {
    const nav = frontView(room);
    nav.setScene({ raycast: (o, d) => (80 - o.y) / d.y, groundZ: () => null });
    expect(nav.pose.ortho).toBe(true);
    for (let i = 0; i < 12; i++) {
      nav.wheel(400, 300, -240);
      settle(nav);
      expect(nav.pose.ortho).toBe(true);
    }
    expect(room.containsPoint(nav.eye())).toBe(true);
  });

  it("a wheel back and forth across the wall swaps the projection at most once", () => {
    const nav = new Navigator();
    nav.setFrame(800, 600);
    nav.setContentBox(room);
    nav.setProjectionMode("auto");
    nav.setLookAt(new THREE.Vector3(0, -90, 0), new THREE.Vector3(0, 0, 0));
    settle(nav);
    let swaps = 0;
    let was = nav.pose.ortho;
    expect(was).toBe(false);
    for (let i = 0; i < 40; i++) {
      nav.wheel(400, 300, i % 2 ? -240 : 240);
      for (let t = 0; t < 15; t++) {
        nav.update(1 / 60);
        if (nav.pose.ortho !== was) swaps++;
        was = nav.pose.ortho;
      }
    }
    expect(swaps).toBeLessThanOrEqual(1);
  });
});

describe("autoWantsOrtho on a box with no usable size", () => {
  const dir = new THREE.Vector3(0, 5, 0);
  const box = (min: number[], max: number[]) =>
    new THREE.Box3(
      new THREE.Vector3(...(min as [number, number, number])),
      new THREE.Vector3(...(max as [number, number, number])),
    );

  it("treats a NaN box as no box, so an axis view is orthographic", () => {
    const nan = box([NaN, NaN, NaN], [NaN, NaN, NaN]);
    expect(autoWantsOrtho(dir, new THREE.Vector3(0, -5, 0), nan, false)).toBe(true);
    expect(autoWantsOrtho(dir, new THREE.Vector3(0, -5, 0), nan, true)).toBe(true);
  });

  it("is perspective anywhere in an infinite box", () => {
    const all = box([-Infinity, -Infinity, -Infinity], [Infinity, Infinity, Infinity]);
    expect(autoWantsOrtho(dir, new THREE.Vector3(0, -5, 0), all, false)).toBe(false);
    expect(autoWantsOrtho(dir, new THREE.Vector3(0, -5, 0), all, true)).toBe(false);
  });

  it("is perspective only exactly on a zero size box", () => {
    const point = box([1, 1, 1], [1, 1, 1]);
    expect(autoWantsOrtho(dir, new THREE.Vector3(1, 1, 1), point, false)).toBe(false);
    expect(autoWantsOrtho(dir, new THREE.Vector3(1, 0.5, 1), point, false)).toBe(true);
  });

  it("holds the hysteresis band of a flat part with one dimension 0", () => {
    const flat = box([-10, 0, -10], [10, 0, 10]);
    const band = new THREE.Vector3(0, -0.1, 0);
    expect(autoWantsOrtho(dir, band, flat, false)).toBe(false);
    expect(autoWantsOrtho(dir, band, flat, true)).toBe(true);
    expect(autoWantsOrtho(dir, new THREE.Vector3(0, -5, 0), flat, false)).toBe(true);
  });

  it("is judged the same far from the origin", () => {
    const far = box([1e7 - 1, -1, -1], [1e7 + 1, 1, 1]);
    expect(autoWantsOrtho(dir, new THREE.Vector3(1e7, -0.5, 0), far, false)).toBe(false);
    expect(autoWantsOrtho(dir, new THREE.Vector3(1e7, -5, 0), far, false)).toBe(true);
  });
});
