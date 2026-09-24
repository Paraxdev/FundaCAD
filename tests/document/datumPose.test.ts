import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  placeDatum,
  poseFromPlaced,
  poseFields,
  sourceOfPlaced,
  turnAxes,
  ZERO_POSE,
  type DatumPose,
} from "../../src/document/datumPose";
import type { PlaneDef } from "../../src/types";

const close = (a: readonly number[], b: readonly number[]) =>
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));

const pose = (p: Partial<DatumPose>): DatumPose => ({ ...ZERO_POSE, ...p });

describe("datum pose", () => {
  // the same numbers crates/fundacad-geom/src/features/datum.rs asserts
  it("tilts about the reference x through the offset point", () => {
    const d = placeDatum("XY", pose({ offset: 20, tiltX: 30 }));
    close(d.origin, [0, 0, 20]);
    close(d.normal, [0, -Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)]);
    close(d.xdir, [1, 0, 0]);
  });

  it("composes tilts and spin in the engine's order", () => {
    const p = placeDatum("XY", pose({ tiltX: 90, spin: 90 }));
    expect(p.normal).toEqual([0, -1, 0]);
    expect(p.xdir).toEqual([0, 0, 1]);
    const q = placeDatum("XY", pose({ tiltY: 90, shiftX: 5, shiftY: -3 }));
    close(q.origin, [5, -3, 0]);
    expect(q.normal).toEqual([1, 0, 0]);
    expect(q.xdir).toEqual([0, 0, -1]);
  });

  it("leaves an untilted plane exactly the old offset plane", () => {
    expect(placeDatum("XZ", pose({ offset: 7 }))).toEqual({ origin: [0, -7, 0], normal: [0, -1, 0], xdir: [1, 0, 0] });
  });

  it("backs the reference out of a placed plane", () => {
    const src: PlaneDef = { origin: [3, 4, 5], normal: [0, 0.6, 0.8], xdir: [1, 0, 0] };
    const p = pose({ offset: 12, shiftX: -2, shiftY: 7, tiltX: 33, tiltY: -71, spin: 140 });
    const back = sourceOfPlaced(placeDatum(src, p), p);
    close(back.origin, src.origin);
    close(back.normal, src.normal);
    close(back.xdir, src.xdir);
  });

  it("recovers the pose that reaches a target placement", () => {
    const p = pose({ offset: 20, shiftX: 4, tiltX: 45, tiltY: 10, spin: 90 });
    const got = poseFromPlaced("XY", placeDatum("XY", p));
    for (const k of Object.keys(p) as (keyof DatumPose)[]) expect(got[k]).toBeCloseTo(p[k], 6);
  });

  it("names the axis each angle turns about, independent of that angle", () => {
    for (const tiltY of [0, 25, 60]) {
      const a = turnAxes("XY", pose({ tiltX: 30, tiltY }));
      // tiltY turns about y as tiltX left it, which tiltY itself cannot move
      close(a.tiltY.toArray(), [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)]);
    }
    // a spin is a turn about the placed normal
    const p = pose({ tiltX: 30, tiltY: 20 });
    close(turnAxes("XY", p).spin.toArray(), placeDatum("XY", p).normal);
  });

  it("turning about an axis from turnAxes changes only that angle", () => {
    const p = pose({ offset: 5, tiltX: 30, tiltY: 20, spin: 15 });
    const placed = placeDatum("XY", p);
    const axis = turnAxes("XY", p).tiltY;
    const q = new THREE.Quaternion().setFromAxisAngle(axis, (10 * Math.PI) / 180);
    const n = new THREE.Vector3(...placed.normal).applyQuaternion(q);
    const x = new THREE.Vector3(...placed.xdir).applyQuaternion(q);
    const got = poseFromPlaced("XY", { origin: placed.origin, normal: n.toArray() as never, xdir: x.toArray() as never });
    expect(got.tiltX).toBeCloseTo(30, 6);
    expect(got.tiltY).toBeCloseTo(30, 6);
    expect(got.spin).toBeCloseTo(15, 6);
  });

  it("writes only the fields that are not zero", () => {
    expect(poseFields(pose({ offset: 20, tiltX: 30 }))).toEqual({ offset: 20, tiltX: 30 });
  });
});
