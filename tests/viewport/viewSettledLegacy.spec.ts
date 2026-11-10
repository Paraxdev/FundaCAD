// The Classic camera turns to a named view on camera-controls' own transition, and the settle wait has to see it.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createLegacyRig } from "../../src/viewport/legacyRig";
import { whenViewSettles } from "../../src/viewport/viewSettled";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));

function makeRig() {
  const dom = document.createElement("canvas");
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
  document.body.append(dom);
  const rig = createLegacyRig(dom, 800 / 600);
  rig.resize(800, 600);
  rig.setLookAt(new THREE.Vector3(30, -50, 20), new THREE.Vector3(0, 0, 0), false);
  for (let i = 0; i < 30; i++) rig.update(1 / 60);
  return rig;
}

// The back view's eye sits on +Y, so it looks along -Y.
const towardBack = (rig: ReturnType<typeof makeRig>) => {
  const d = rig.viewDirection(new THREE.Vector3()).normalize();
  return d.y < -Math.cos(THREE.MathUtils.degToRad(1));
};

afterEach(() => {
  vi.useRealTimers();
});

describe("whenViewSettles, Classic camera", () => {
  it("waits out a named view's turn whose frames stall, and fires once it lands", () => {
    vi.useFakeTimers();
    const rig = makeRig();
    rig.setStandardView("back");
    for (let i = 0; i < 3; i++) rig.update(1 / 60);
    const then = vi.fn();
    whenViewSettles(rig, 250, then);
    // No frames: the pose version stands still while the turn is a few degrees in.
    vi.advanceTimersByTime(2000);
    const early = [then.mock.calls.length, rig.isFlying(), towardBack(rig)];
    for (let i = 0; i < 600 && rig.isFlying(); i++) rig.update(1 / 60);
    vi.advanceTimersByTime(600);
    expect([early, then.mock.calls.length, rig.isFlying(), towardBack(rig)]).toEqual([
      [0, true, false],
      1,
      false,
      true,
    ]);
  });

  it("lets a drag take over the turn, so the user's own motion is no named view in the air", () => {
    const rig = makeRig();
    rig.setViewDir(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), true);
    rig.update(1 / 60);
    const during = rig.isFlying();
    rig.controls.dispatchEvent({ type: "controlstart" });
    expect([during, rig.isFlying()]).toEqual([true, false]);
  });

  it("lets a view already there settle in a couple of frames, not hang in the air", () => {
    const rig = makeRig();
    rig.setStandardView("front");
    for (let i = 0; i < 600 && rig.isFlying(); i++) rig.update(1 / 60);
    rig.setStandardView("front");
    let frames = 0;
    for (; frames < 600 && rig.isFlying(); frames++) rig.update(1 / 60);
    expect(frames).toBeLessThanOrEqual(2);
  });
});
