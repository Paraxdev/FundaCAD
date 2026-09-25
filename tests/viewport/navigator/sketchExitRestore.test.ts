// sketchMode.ts captures the pre-sketch view with viewDirection() (the
// camera's look-along, eye toward target) and restores it on a normal exit
// with setViewDir/turnTo, whose `dir` is the OPPOSITE convention (eye = target
// + dir*d, see cameras.ts and viewport.applyOverride's face-normal use of the
// same call). Feeding one straight into the other without negating flips the
// restored camera to the far side of the model: round 2's PM-6, a fresh
// sketch+extrude leaving the nav cube reading BOTTOM instead of the iso corner
// the document opened on.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { setup, settle } from "./kit";
import { lookQuatUp } from "../../../src/viewport/navigator/navigator";
import { forwardOf, upOf } from "../../../src/viewport/navigator/pose";

describe("sketch-exit view restore (the viewDirection/setViewDir sign convention)", () => {
  it("round-trips back to the original forward direction, negated", () => {
    const { nav } = setup(); // the default iso corner a fresh document opens on
    const originalForward = forwardOf(nav.pose).clone();

    // capture, as sketchMode.enter now does: viewDirection() negated into the
    // eye-offset convention setViewDir expects
    const preSketchDir = forwardOf(nav.pose).clone().negate();
    const preSketchUp = upOf(nav.pose).clone();

    // enterSketchView: turn to look straight down at the XY plane
    nav.turnTo(lookQuatUp(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)), false);
    settle(nav);
    expect(forwardOf(nav.pose).angleTo(originalForward)).toBeGreaterThan(0.1); // it did turn

    // exitSketchView's restore
    nav.turnTo(lookQuatUp(preSketchDir, preSketchUp), false);
    settle(nav);

    expect(forwardOf(nav.pose).angleTo(originalForward)).toBeLessThan(1e-4);
  });

  it("an un-negated capture would land on the opposite side (the PM-6 regression)", () => {
    const { nav } = setup();
    const originalForward = forwardOf(nav.pose).clone();

    // the bug: no .negate()
    const buggyDir = forwardOf(nav.pose).clone();
    const up = upOf(nav.pose).clone();

    nav.turnTo(lookQuatUp(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)), false);
    settle(nav);
    nav.turnTo(lookQuatUp(buggyDir, up), false);
    settle(nav);

    // near PI apart: the camera ended up looking from roughly the opposite side
    expect(forwardOf(nav.pose).angleTo(originalForward)).toBeGreaterThan(Math.PI - 0.2);
  });
});
