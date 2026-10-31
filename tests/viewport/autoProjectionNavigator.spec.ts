// 'auto' projection stays in perspective while the eye is inside the content box, in the default navigator.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
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
