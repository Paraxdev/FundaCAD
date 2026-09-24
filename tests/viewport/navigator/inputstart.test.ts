// "inputstart" fires for a real gesture (orbit, pan) and only that: sketchMode
// restores the pre-sketch view direction on a normal exit unless the user
// orbited their own way out mid-session, a decision that only holds if a
// programmatic turn (the restore itself, or any other flyTo/turnTo) can never
// be mistaken for that gesture.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { settle, setup } from "./kit";
import { lookQuatUp } from "../../../src/viewport/navigator/navigator";

describe("inputstart", () => {
  it("fires once for a real orbit drag", () => {
    const { nav } = setup();
    let count = 0;
    nav.on("inputstart", () => count++);
    nav.beginOrbit(400, 300);
    nav.dragTo(430, 320);
    nav.update(1 / 60);
    nav.endGesture();
    expect(count).toBe(1);
  });

  it("fires once for a real pan drag", () => {
    const { nav } = setup();
    let count = 0;
    nav.on("inputstart", () => count++);
    nav.beginPan(400, 300);
    nav.dragTo(430, 320);
    nav.update(1 / 60);
    nav.endGesture();
    expect(count).toBe(1);
  });

  it("does not fire for a programmatic turnTo (the sketch-exit restore)", () => {
    const { nav } = setup();
    let count = 0;
    nav.on("inputstart", () => count++);
    nav.turnTo(lookQuatUp(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1)), false);
    settle(nav);
    expect(count).toBe(0);
  });

  it("does not fire for a programmatic fitSphere/resetView flight", () => {
    const { nav } = setup();
    let count = 0;
    nav.on("inputstart", () => count++);
    nav.fitSphere(new THREE.Vector3(1, 2, 3), 5, { animate: false });
    nav.resetView(new THREE.Vector3(0, 0, 0), 5, false);
    settle(nav);
    expect(count).toBe(0);
  });
});
