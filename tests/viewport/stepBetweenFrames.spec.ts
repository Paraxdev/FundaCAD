// An arrow step, a 3D mouse turn or a zoom from the keyboard lands between frames. The next frame has to count it as a
// move, or the viewport's still timer never starts and the traced picture shows between key repeats.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { CameraRig } from "../../src/viewport/cameras";
import { createLegacyRig } from "../../src/viewport/legacyRig";
import { createNavigatorRig } from "../../src/viewport/navigator/rig";

const BOX = new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));

function canvas() {
  const dom = document.createElement("canvas");
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
  document.body.append(dom);
  return dom;
}

function still(rig: CameraRig): CameraRig {
  rig.resize(800, 600);
  rig.setContentBox(BOX);
  rig.fit(BOX, false);
  for (let i = 0; i < 600 && rig.update(1 / 60); i++);
  expect(rig.update(1 / 60)).toBe(false);
  return rig;
}

const navigatorRig = () => createNavigatorRig(canvas(), 800 / 600);
const rigs: [string, () => CameraRig][] = [
  ["Navigator", navigatorRig],
  ["Classic", () => createLegacyRig(canvas(), 800 / 600)],
];

describe.each(rigs)("the %s rig", (_, make) => {
  it("counts an arrow step between frames as a move on the next frame", () => {
    const rig = still(make());
    rig.stepView("right", false);
    expect(rig.update(1 / 60)).toBe(true);
  });

  it("counts every step of a held arrow, one between each pair of frames", () => {
    const rig = still(make());
    const frames: boolean[] = [];
    for (let i = 0; i < 30; i++) {
      rig.stepView("left", true);
      frames.push(rig.update(1 / 60));
      frames.push(rig.update(1 / 60));
    }
    expect(frames.filter((_, i) => i % 2 === 0)).toEqual(Array(30).fill(true));
  });

  it("counts a 3D mouse turn and roll between frames", () => {
    const rig = still(make());
    rig.tumble(0.02, 0.01);
    expect(rig.update(1 / 60)).toBe(true);
    for (let i = 0; i < 600 && rig.update(1 / 60); i++);
    rig.roll(0.02);
    expect(rig.update(1 / 60)).toBe(true);
  });
});

describe("the Navigator rig", () => {
  it("counts a move between frames once, the frame after is still", () => {
    const rig = still(navigatorRig());
    rig.stepView("up", false);
    expect([rig.update(1 / 60), rig.update(1 / 60)]).toEqual([true, false]);
  });

  it("does not count a new content box, which moves no pose", () => {
    const rig = still(navigatorRig());
    rig.setContentBox(new THREE.Box3(new THREE.Vector3(-40, -40, -40), new THREE.Vector3(40, 40, 40)));
    expect(rig.update(1 / 60)).toBe(false);
  });
});
