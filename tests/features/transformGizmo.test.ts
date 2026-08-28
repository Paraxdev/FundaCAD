// Turning bodies with a gizmo.
//
// The measurement that matters is the pivot one: a rotation the kernel applies
// about the WORLD origin has to be made to look like a rotation about the
// gizmo, and the control is the same rotation without the correction, which
// throws the body across the scene.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  angleDelta,
  angleInFrame,
  composeMove,
  moveMatrix,
  ringDragDegenerate,
  rotationFrame,
  snapDegrees,
} from "../../src/features/transformGizmo";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const ZERO = v(0, 0, 0);
const qAbout = (axis: THREE.Vector3, deg: number) =>
  new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), (deg * Math.PI) / 180);

describe("rotationFrame", () => {
  it("spans the plane the rotation happens in, right-handed about the axis", () => {
    for (const axis of [v(1, 0, 0), v(0, 1, 0), v(0, 0, 1), v(1, 2, -3)]) {
      const f = rotationFrame(axis);
      const n = axis.clone().normalize();
      expect(f.u.length()).toBeCloseTo(1, 9);
      expect(f.v.length()).toBeCloseTo(1, 9);
      expect(f.u.dot(n)).toBeCloseTo(0, 9);
      expect(f.v.dot(n)).toBeCloseTo(0, 9);
      // u x v points ALONG the axis, which is what makes a positive angle a
      // right-handed turn — get this backwards and the ring drags the wrong way.
      expect(f.u.clone().cross(f.v).dot(n)).toBeCloseTo(1, 9);
    }
  });
});

describe("angleInFrame", () => {
  it("measures a quarter turn as a quarter turn", () => {
    const f = rotationFrame(v(0, 0, 1));
    const pivot = v(5, 5, 0);
    const a = angleInFrame(pivot.clone().add(f.u.clone().multiplyScalar(10)), pivot, f);
    const b = angleInFrame(pivot.clone().add(f.v.clone().multiplyScalar(10)), pivot, f);
    expect(angleDelta(a, b)).toBeCloseTo(Math.PI / 2, 9);
  });

  it("ignores how far out the point is", () => {
    const f = rotationFrame(v(0, 1, 0));
    const p = v(3, 0, 4);
    const near = angleInFrame(p, ZERO, f);
    const far = angleInFrame(p.clone().multiplyScalar(100), ZERO, f);
    expect(far).toBeCloseTo(near, 9);
  });
});

describe("angleDelta", () => {
  it("takes the short way round the seam", () => {
    // A drag that crosses +-pi. Without this the turn reads as most of a circle
    // in the wrong direction, once per revolution.
    expect(angleDelta(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6, 9);
    expect(angleDelta(3.0, -3.0)).toBeGreaterThan(0);
    expect(angleDelta(-3.0, 3.0)).toBeLessThan(0);
    expect(angleDelta(0.1, 0.4)).toBeCloseTo(0.3, 9);
  });
});

describe("snapDegrees", () => {
  it("lands on the turns people mean", () => {
    expect(snapDegrees(43.2, 15)).toBe(45);
    expect(snapDegrees(-7.4, 15)).toBe(-0);
    expect(snapDegrees(88, 15)).toBe(90);
  });
  it("leaves the angle alone when stepping is off", () => {
    expect(snapDegrees(43.2, 0)).toBe(43.2);
    expect(snapDegrees(43.2, -1)).toBe(43.2);
  });
});

describe("composeMove", () => {
  it("turns a body where it stands", () => {
    // THE measurement. A 30mm cube whose centre is 300mm out along X, turned a
    // quarter turn about its own centre: the centre must not move.
    const pivot = v(300, 0, 0);
    const rot = qAbout(v(0, 0, 1), 90);
    const mv = composeMove(pivot, rot, ZERO);
    const landed = pivot.clone().applyMatrix4(moveMatrix(mv));
    expect(landed.distanceTo(pivot)).toBeLessThan(1e-9);

    // CONTROL: the same rotation with no pivot correction — which is what the
    // feature does on its own — swings it 424mm across the scene.
    const raw = composeMove(ZERO, rot, ZERO);
    const thrown = pivot.clone().applyMatrix4(moveMatrix(raw));
    expect(thrown.distanceTo(pivot)).toBeGreaterThan(400);
  });

  it("turns the body itself, not only its centre", () => {
    const pivot = v(300, 0, 0);
    const corner = v(315, 15, 0); // a corner of a 30mm cube at that centre
    const mv = composeMove(pivot, qAbout(v(0, 0, 1), 90), ZERO);
    const landed = corner.clone().applyMatrix4(moveMatrix(mv));
    // a quarter turn anticlockwise about (300,0,0) sends (315,15) to (285,15)
    expect(landed.x).toBeCloseTo(285, 9);
    expect(landed.y).toBeCloseTo(15, 9);
  });

  it("adds the drag's own translation on top", () => {
    const pivot = v(300, 0, 0);
    const mv = composeMove(pivot, qAbout(v(0, 0, 1), 90), v(0, 0, 40));
    const landed = pivot.clone().applyMatrix4(moveMatrix(mv));
    expect(landed.x).toBeCloseTo(300, 9);
    expect(landed.z).toBeCloseTo(40, 9);
  });

  it("reads the angles back in the kernel's own order", () => {
    // Rot(rx, ry, rz) composes as Rx . Ry . Rz, which is three.js "XYZ". A
    // single-axis turn agrees under any order, so the control is a rotation
    // that uses two of them: read back as ZYX it lands somewhere else.
    const rot = qAbout(v(1, 0, 0), 40).multiply(qAbout(v(0, 1, 0), 50));
    const mv = composeMove(ZERO, rot, ZERO);
    const p = v(1, 2, 3);
    const byMatrix = p.clone().applyMatrix4(moveMatrix(mv));
    const byQuat = p.clone().applyQuaternion(rot);
    expect(byMatrix.distanceTo(byQuat)).toBeLessThan(1e-9);

    const rad = (d: number) => (d * Math.PI) / 180;
    const wrongOrder = p.clone().applyEuler(
      new THREE.Euler(rad(mv.rx), rad(mv.ry), rad(mv.rz), "ZYX"),
    );
    expect(wrongOrder.distanceTo(byQuat)).toBeGreaterThan(0.1);
  });

  it("is the identity when nothing was dragged", () => {
    const mv = composeMove(v(7, 8, 9), new THREE.Quaternion(), ZERO);
    expect(mv).toEqual({ dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0 });
  });
});

describe("ringDragDegenerate", () => {
  it("refuses only the edge-on case", () => {
    expect(ringDragDegenerate(1)).toBe(false); // looking down the axis: the good case
    expect(ringDragDegenerate(0.5)).toBe(false);
    expect(ringDragDegenerate(0)).toBe(true); // the ring is a line on screen
    expect(ringDragDegenerate(-0.02)).toBe(true);
    expect(ringDragDegenerate(-1)).toBe(false); // down the axis, from the far side
  });
});
