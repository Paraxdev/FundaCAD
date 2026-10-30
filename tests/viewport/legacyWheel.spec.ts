// The Classic camera: a wheel zooms, Ctrl with a mouse notch pans up and down, and a pinch still zooms.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createLegacyRig } from "../../src/viewport/legacyRig";

function setup() {
  const dom = document.createElement("canvas");
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
  document.body.append(dom);
  const rig = createLegacyRig(dom, 800 / 600);
  rig.resize(800, 600);
  rig.setProjectionMode("ortho");
  const wheel = (init: Record<string, unknown>) => {
    rig.wheel({
      clientX: 400,
      clientY: 300,
      deltaX: 0,
      deltaMode: 0,
      ctrlKey: false,
      preventDefault() {},
      ...init,
    } as never);
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
  };
  const screenY = (p: THREE.Vector3) => {
    rig.active.updateMatrixWorld(true);
    return p.clone().project(rig.active).y;
  };
  return { rig, wheel, screenY };
}

describe("Classic camera wheel", () => {
  const point = new THREE.Vector3();

  it("a plain wheel zooms", () => {
    const { rig, wheel } = setup();
    const s0 = rig.viewScale();
    wheel({ deltaY: -100, wheelDeltaY: 120 });
    expect(rig.viewScale()).not.toBeCloseTo(s0, 6);
  });

  it("Ctrl with a mouse notch pans the content up for a scroll down, without zooming", () => {
    const { rig, wheel, screenY } = setup();
    const s0 = rig.viewScale();
    const y0 = screenY(point);
    wheel({ deltaY: 100, wheelDeltaY: -120, ctrlKey: true });
    expect(rig.viewScale()).toBeCloseTo(s0, 9);
    expect(screenY(point)).toBeGreaterThan(y0);
  });

  it("Ctrl with a notch at an Interface size pans too", () => {
    const { rig, wheel } = setup();
    const s0 = rig.viewScale();
    globalThis.devicePixelRatio = 1.1;
    try {
      wheel({ deltaY: 90.90908893868948, wheelDeltaY: -109, ctrlKey: true });
    } finally {
      globalThis.devicePixelRatio = 1;
    }
    expect(rig.viewScale()).toBeCloseTo(s0, 9);
  });

  it("a Ctrl pinch zooms", () => {
    const { rig, wheel } = setup();
    const s0 = rig.viewScale();
    wheel({ deltaY: -5.5, ctrlKey: true });
    expect(rig.viewScale()).not.toBeCloseTo(s0, 6);
  });
});
