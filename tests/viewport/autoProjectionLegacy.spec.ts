// 'auto' projection stays in perspective while the eye is inside the content box, in the Classic camera.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { onWorldAxis } from "../../src/viewport/autoProjection";
import { createLegacyRig } from "../../src/viewport/legacyRig";
import { autoProjectionCases } from "./autoProjectionCases";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));

function makeCanvas() {
  const dom = document.createElement("canvas");
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
  document.body.append(dom);
  return dom;
}

function makeRig(dom = makeCanvas()) {
  const rig = createLegacyRig(dom, 800 / 600);
  rig.resize(800, 600);
  return rig;
}

describe("auto projection, Classic camera", () => {
  autoProjectionCases(makeRig);

  it("a real wheel during the flight of a click is no controlstart and lands on the clicked view, orthographic", () => {
    for (const frames of [0, 3]) {
      const dom = makeCanvas();
      const rig = makeRig(dom);
      rig.setContentBox(new THREE.Box3(new THREE.Vector3(-100, -100, -100), new THREE.Vector3(100, 100, 100)));
      rig.setProjectionMode("auto");
      rig.setLookAt(new THREE.Vector3(30, -50, 20), new THREE.Vector3(0, 0, 0), false);
      for (let i = 0; i < 30; i++) rig.update(1 / 60);
      let starts = 0;
      rig.controls.addEventListener("controlstart", () => starts++);
      rig.setStandardView("front");
      for (let i = 0; i < frames; i++) rig.update(1 / 60);
      // The test DOM's WheelEvent has no clientX, which would make the zoom pivot NaN.
      const wheel = Object.assign(new Event("wheel", { cancelable: true }), {
        deltaY: -100,
        deltaMode: 0,
        clientX: 400,
        clientY: 300,
      });
      dom.dispatchEvent(wheel);
      for (let i = 0; i < 120; i++) rig.update(1 / 60);
      const look = rig.viewDirection(new THREE.Vector3());
      expect([frames, starts, onWorldAxis(look.x, look.y, look.z), look.y > 0, rig.isOrtho()]).toEqual([
        frames,
        0,
        true,
        true,
        true,
      ]);
    }
  });

  it("a camera drag back onto the clicked view before it rests lands in perspective inside", () => {
    const rig = makeRig();
    rig.setContentBox(new THREE.Box3(new THREE.Vector3(-100, -100, -100), new THREE.Vector3(100, 100, 100)));
    rig.setProjectionMode("auto");
    rig.setLookAt(new THREE.Vector3(0, -50, 0), new THREE.Vector3(0, 0, 0), false);
    for (let i = 0; i < 30; i++) rig.update(1 / 60);
    expect(rig.isOrtho()).toBe(false);
    rig.setStandardView("front");
    rig.controls.dispatchEvent({ type: "controlstart" });
    rig.controls.rotate(0.3, 0, false);
    rig.update(1 / 60);
    rig.controls.rotate(-0.3, 0, false);
    for (let i = 0; i < 120; i++) rig.update(1 / 60);
    expect(rig.isOrtho()).toBe(false);
  });
});
