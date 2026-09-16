// Orbiting about a point that is not the orbit target.
//
// camera-controls always aims the camera at its target, so the point it turns
// about is the one at the centre of the screen. A pan moves that target with the
// camera and an orthographic zoom-to-cursor trucks both toward the cursor, so
// after a couple of ordinary gestures it sits well off the model and orbiting
// swings the model through an arc the size of that offset. Measured in a
// browser on a 40x30x20 box: one 380px pan put the target 61mm from a model of
// radius 27mm, and the next orbit took half the model off the top of the screen.
//
// The correction is a rigid translation applied after the library's own
// rotation. What has to hold is the identity it rests on, which is what this
// file pins: rotate-about-target-then-shift IS rotate-about-pivot, for every
// point, which is the only reason the shift can be a single vector rather than
// something that depends on what is being looked at.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { frameRotation, pivotProbes, pivotShift, viewQuaternion } from "../../src/viewport/orbitPivot";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Rotate `p` about `centre` by `q`, the operation the shift has to reproduce. */
function rotateAbout(p: THREE.Vector3, centre: THREE.Vector3, q: THREE.Quaternion) {
  return p.clone().sub(centre).applyQuaternion(q).add(centre);
}

describe("pivotShift", () => {
  const q = new THREE.Quaternion().setFromAxisAngle(v(0.3, -0.5, 0.81).normalize(), 0.7);

  it("turns a rotation about the target into one about the pivot", () => {
    const target = v(61, -12, 4);
    const pivot = v(-3, 5, 9);
    const d = pivotShift(q, pivot, target);

    // The identity the whole approach rests on. Several unrelated points,
    // because a shift that only worked for one of them would be a coincidence
    // and would show up as the model sliding during a drag.
    for (const p of [v(0, 0, 0), v(100, -40, 12), v(-7, -7, -7), pivot.clone(), target.clone()]) {
      const viaTarget = rotateAbout(p, target, q).add(d);
      const direct = rotateAbout(p, pivot, q);
      expect(viaTarget.distanceTo(direct)).toBeLessThan(1e-9);
    }
  });

  it("leaves the pivot itself exactly where it was", () => {
    // This is what stops the model swinging out of frame: the pivot is on the
    // model, and a rotation about it does not move it at all.
    const target = v(61, -12, 4);
    const pivot = v(-3, 5, 9);
    const moved = rotateAbout(pivot, target, q).add(pivotShift(q, pivot, target));
    expect(moved.distanceTo(pivot)).toBeLessThan(1e-9);
  });

  it("is zero when the pivot IS the target", () => {
    // The unchanged case: nothing has drifted, so there is nothing to correct
    // and the library's own behaviour is left exactly alone.
    const t = v(4, 5, 6);
    expect(pivotShift(q, t.clone(), t).length()).toBeLessThan(1e-12);
  });

  it("is zero for a rotation of nothing", () => {
    // Which is what makes the correction safe to run on every frame: a pan and a
    // zoom move the rig without turning it, so they produce no shift rather than
    // having to be detected and skipped.
    const none = new THREE.Quaternion();
    expect(pivotShift(none, v(-3, 5, 9), v(61, -12, 4)).length()).toBeLessThan(1e-12);
  });
});

describe("viewQuaternion", () => {
  it("reads the basis back out of a position, target and up", () => {
    const pos = v(0, -10, 0);
    const tgt = v(0, 0, 0);
    const q = viewQuaternion(pos, tgt, v(0, 0, 1))!;
    expect(q).not.toBeNull();
    // Looking along +Y with Z up: the camera's own -Z axis points at the target.
    const fwd = v(0, 0, -1).applyQuaternion(q);
    expect(fwd.distanceTo(v(0, 1, 0))).toBeLessThan(1e-9);
  });

  it("has nothing to report when the camera sits on its target", () => {
    // A degenerate frame has no view direction, and inventing one would put a
    // meaningless rotation into the next frame's measurement.
    expect(viewQuaternion(v(1, 1, 1), v(1, 1, 1), v(0, 0, 1))).toBeNull();
  });
});

describe("frameRotation", () => {
  it("recovers the rotation between two camera bases", () => {
    const up = v(0, 0, 1);
    const before = viewQuaternion(v(0, -10, 0), v(0, 0, 0), up)!;
    const after = viewQuaternion(v(10, 0, 0), v(0, 0, 0), up)!;
    const q = frameRotation(before, after);
    // Applying it to the first basis has to give the second.
    const composed = q.clone().multiply(before);
    expect(Math.abs(Math.abs(composed.dot(after)) - 1)).toBeLessThan(1e-9);
  });
});

describe("pivotProbes", () => {
  const rect = { left: 0, top: 0, right: 800, bottom: 600 };

  it("walks outward from the cursor, nearest ring first", () => {
    const probes = pivotProbes(400, 300, rect, 32);
    const dist = probes.map((p) => Math.hypot(p.x - 400, p.y - 300));
    for (let i = 1; i < dist.length; i++) expect(dist[i]).toBeGreaterThanOrEqual((dist[i - 1] ?? 0) - 1e-6);
    expect(dist[0]).toBeCloseTo(32);
  });

  it("stays on the canvas and reaches its far corner from an edge", () => {
    const probes = pivotProbes(10, 10, rect, 32);
    expect(probes.every((p) => p.x >= 0 && p.x <= 800 && p.y >= 0 && p.y <= 600)).toBe(true);
    expect(probes.some((p) => p.x > 700 && p.y > 500)).toBe(true);
  });
});
