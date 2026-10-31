// 'auto' projection stays in perspective while the eye is inside the content box, in the Classic camera.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createLegacyRig } from "../../src/viewport/legacyRig";
import { autoProjectionCases } from "./autoProjectionCases";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));

function makeRig() {
  const dom = document.createElement("canvas");
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
  document.body.append(dom);
  const rig = createLegacyRig(dom, 800 / 600);
  rig.resize(800, 600);
  return rig;
}

describe("auto projection, Classic camera", () => {
  autoProjectionCases(makeRig);

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
