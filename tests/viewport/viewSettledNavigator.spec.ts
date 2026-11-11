// An arrow step in the default navigator settles on the projection it turned to, even when no frame follows it.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createNavigatorRig } from "../../src/viewport/navigator/rig";
import { whenViewSettles } from "../../src/viewport/viewSettled";
import type { ProjectionMode } from "../../src/viewport/cameras";

function makeRig(mode: ProjectionMode) {
  const dom = document.createElement("canvas");
  const rig = createNavigatorRig(dom, 4 / 3);
  rig.resize(800, 600);
  rig.setContentBox(new THREE.Box3(new THREE.Vector3(12, -7, 3), new THREE.Vector3(31, 9, 17)));
  rig.setProjectionMode(mode);
  rig.setLookAt(new THREE.Vector3(60, -70, 40), new THREE.Vector3(21, 1, 10), false);
  rig.update(1 / 60);
  rig.setStandardView("back");
  for (let i = 0; i < 1000 && rig.isFlying(); i++) rig.update(1 / 60);
  for (let i = 0; i < 3; i++) rig.update(1 / 60);
  return rig;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("whenViewSettles, default navigator", () => {
  const stepWithoutFrames = (mode: ProjectionMode) => {
    vi.useFakeTimers();
    const rig = makeRig(mode);
    const before = rig.isOrtho();
    const dir = rig.viewDirection(new THREE.Vector3());
    rig.stepView("left", false);
    const then = vi.fn(() => [
      rig.isOrtho(),
      THREE.MathUtils.radToDeg(rig.viewDirection(new THREE.Vector3()).angleTo(dir)),
    ]);
    whenViewSettles(rig, 250, then);
    vi.advanceTimersByTime(2000);
    return [before, then.mock.calls.length, then.mock.results[0]?.value];
  };

  it("in auto, an arrow step off the back view settles as perspective with no frame after it", () => {
    expect(stepWithoutFrames("auto")).toEqual([true, 1, [false, expect.closeTo(15, 3)]]);
  });

  it("in orthographic, an arrow step stays orthographic", () => {
    expect(stepWithoutFrames("ortho")).toEqual([true, 1, [true, expect.closeTo(15, 3)]]);
  });

  it("in perspective, an arrow step stays perspective", () => {
    expect(stepWithoutFrames("persp")).toEqual([false, 1, [false, expect.closeTo(15, 3)]]);
  });
});
