// Fit frames the model's box, not its bounding ball, so the silhouette sits
// FIT_MARGIN in from the nearest edge of the view whatever its shape, in both
// projections. Framing the ball left a tall part 6.5% from the top and bottom
// and a long bar more than 20% from every edge.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createNavigatorRig } from "../../../src/viewport/navigator/rig";
import { FIT_MARGIN, HOME_EYE, lookQuat } from "../../../src/viewport/navigator/navigator";
import { project, setOrientation } from "../../../src/viewport/navigator/pose";
import { BoxScene, H, W } from "./kit";

const box = (x: number, y: number, z: number, at = new THREE.Vector3()) =>
  new THREE.Box3(new THREE.Vector3(-x / 2, -y / 2, 0).add(at), new THREE.Vector3(x / 2, y / 2, z).add(at));

const MODELS = {
  tower: box(20, 20, 160),
  bar: box(200, 12, 12),
  block: box(40, 24, 23, new THREE.Vector3(30, -10, 5)),
};
const VIEWS = {
  iso: HOME_EYE.clone(),
  front: new THREE.Vector3(0, -1, 0),
  top: new THREE.Vector3(0, 0, 1),
};

function stubCanvas(): HTMLElement {
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

/** Each side's clear share of the view after a Fit, and how much of its axis the model fills. */
function fitted(model: THREE.Box3, eye: THREE.Vector3, mode: "persp" | "ortho", how: "fit" | "reset" = "fit") {
  const rig = createNavigatorRig(stubCanvas(), W / H);
  const scene = new BoxScene([model.clone()]);
  rig.setScene(scene);
  rig.setContentBox(scene.box());
  rig.setProjectionMode(mode);
  rig.resize(W, H);
  rig.navigator.opts.smoothTime = 0;
  setOrientation(rig.navigator.pose, lookQuat(eye, new THREE.Vector3()));
  if (how === "fit") rig.fit(scene.box(), false);
  else rig.resetView(scene.box());
  for (let i = 0; i < 600 && (rig.update(1 / 60) || rig.navigator.isBusy()); i++);
  const nav = rig.navigator;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Vector3(i & 1 ? model.max.x : model.min.x, i & 2 ? model.max.y : model.min.y, i & 4 ? model.max.z : model.min.z);
    const s = project(nav.pose, nav.frame, c);
    xs.push(s.x);
    ys.push(s.y);
  }
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return {
    margins: { left: x0 / W, right: 1 - x1 / W, top: y0 / H, bottom: 1 - y1 / H },
    fill: Math.max((x1 - x0) / W, (y1 - y0) / H),
  };
}

describe("Fit leaves a margin round the model", () => {
  for (const mode of ["persp", "ortho"] as const) {
    for (const [name, model] of Object.entries(MODELS)) {
      for (const [view, eye] of Object.entries(VIEWS)) {
        it(`${name}, ${view}, ${mode}: the nearest edge is FIT_MARGIN away, no side closer`, () => {
          const { margins, fill } = fitted(model, eye, mode);
          const nearest = Math.min(...Object.values(margins));
          expect(nearest).toBeCloseTo(FIT_MARGIN, 3);
          // Not loose either: the binding axis is filled up to its margins.
          expect(fill).toBeGreaterThan(1 - 2 * FIT_MARGIN - 0.12);
        });
      }
    }
  }

  it("the margin is between 10 and 15 percent of the view", () => {
    expect(FIT_MARGIN).toBeGreaterThanOrEqual(0.1);
    expect(FIT_MARGIN).toBeLessThanOrEqual(0.15);
  });

  it("the home view frames the box the same way", () => {
    for (const mode of ["persp", "ortho"] as const) {
      const { margins } = fitted(MODELS.tower, VIEWS.iso, mode, "reset");
      expect(Math.min(...Object.values(margins))).toBeCloseTo(FIT_MARGIN, 3);
    }
  });

  it("a box of one point centres on that point, not on the origin", () => {
    const at = new THREE.Vector3(30, -10, 5);
    const rig = createNavigatorRig(stubCanvas(), W / H);
    rig.resize(W, H);
    rig.navigator.opts.smoothTime = 0;
    rig.fit(new THREE.Box3(at.clone(), at.clone()), false);
    for (let i = 0; i < 600 && (rig.update(1 / 60) || rig.navigator.isBusy()); i++);
    expect(rig.navigator.pose.target.distanceTo(at)).toBeLessThan(1e-9);
    expect(Number.isFinite(rig.navigator.pose.scale) && rig.navigator.pose.scale > 0).toBe(true);
  });

  it("an empty box still frames the origin at a finite scale", () => {
    const rig = createNavigatorRig(stubCanvas(), W / H);
    rig.resize(W, H);
    rig.fit(new THREE.Box3(), false);
    for (let i = 0; i < 600 && (rig.update(1 / 60) || rig.navigator.isBusy()); i++);
    expect(Number.isFinite(rig.navigator.pose.scale) && rig.navigator.pose.scale > 0).toBe(true);
    expect(rig.navigator.pose.target.length()).toBe(0);
  });
});
