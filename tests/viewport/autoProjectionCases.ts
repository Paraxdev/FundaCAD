import { expect, it } from "vitest";
import * as THREE from "three";
import type { CameraRig } from "../../src/viewport/cameras";

const ROOM = new THREE.Box3(new THREE.Vector3(-100, -100, -100), new THREE.Vector3(100, 100, 100));
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** The rig facing +Y from `eye`, settled, with the projection it chose. */
function lookFrom(rig: CameraRig, eye: THREE.Vector3, target = v(0, 0, 0)): boolean {
  rig.setLookAt(eye, target, false);
  for (let i = 0; i < 30; i++) rig.update(1 / 60);
  return rig.isOrtho();
}

/** The same cases for both camera rigs, `make` giving a fresh one with the room as its content. */
export function autoProjectionCases(make: () => CameraRig) {
  const room = () => {
    const rig = make();
    rig.setContentBox(ROOM.clone());
    rig.setProjectionMode("auto");
    return rig;
  };

  it("stays in perspective on an axis with the eye inside the content box", () => {
    expect(lookFrom(room(), v(0, -50, 0))).toBe(false);
  });

  it("snaps to orthographic on an axis with the eye outside the content box", () => {
    expect(lookFrom(room(), v(0, -1500, 0))).toBe(true);
  });

  it("stays in perspective with the eye on the box wall", () => {
    expect(lookFrom(room(), v(0, -100, 0))).toBe(false);
  });

  it("is perspective off an axis whatever the eye", () => {
    expect(lookFrom(room(), v(1500, -1500, 900))).toBe(false);
  });

  it("an explicit Orthographic gives orthographic with the eye inside", () => {
    const rig = room();
    rig.setProjectionMode("ortho");
    expect(lookFrom(rig, v(0, -50, 0))).toBe(true);
  });

  it("an explicit Perspective stays perspective on an axis outside", () => {
    const rig = room();
    rig.setProjectionMode("persp");
    expect(lookFrom(rig, v(0, -1500, 0))).toBe(false);
  });

  it("with no content box an axis view is orthographic", () => {
    const rig = make();
    rig.setProjectionMode("auto");
    expect(lookFrom(rig, v(0, -50, 0))).toBe(true);
  });

  it("an eye crossing the wall back and forth on an axis does not swap on each wiggle", () => {
    const rig = room();
    expect(lookFrom(rig, v(0, -50, 0))).toBe(false);
    let swaps = 0;
    let was = rig.isOrtho();
    for (let i = 0; i < 40; i++) {
      lookFrom(rig, v(0, i % 2 ? -100.5 : -99.5, 0));
      if (rig.isOrtho() !== was) swaps++;
      was = rig.isOrtho();
    }
    expect(swaps).toBe(0);
  });

  it("returns to orthographic once the eye is well clear of the box", () => {
    const rig = room();
    expect(lookFrom(rig, v(0, -50, 0))).toBe(false);
    expect(lookFrom(rig, v(0, -300, 0))).toBe(true);
  });
}
