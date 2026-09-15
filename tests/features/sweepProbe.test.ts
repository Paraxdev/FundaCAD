// The probe points stand in for the solid an extrude sweeps. Wrong ones fail
// quietly: a cut whose points sit on the sketch plane or past the far face asks
// about material the preview never enters, and the body it is buried in stays
// opaque.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { sweepProbePoints, type SweepProfile } from "../../src/features/sweepProbe";

function disc(r: number, z: number, n = 32): SweepProfile {
  const loop: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    loop.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, z));
  }
  return { interior: new THREE.Vector3(0, 0, z), loop, normal: new THREE.Vector3(0, 0, 1) };
}

describe("sweepProbePoints", () => {
  it("keeps every point strictly inside a cut's depth, below the sketch plane", () => {
    const pts = sweepProbePoints([disc(10, 30)], -15, false);
    expect(pts.length).toBeGreaterThan(3);
    for (const p of pts) {
      expect(p.z).toBeLessThan(30);
      expect(p.z).toBeGreaterThan(15);
    }
  });

  it("reaches the near end, the middle and the far end of the sweep", () => {
    const zs = new Set(sweepProbePoints([disc(10, 0)], 20, false).map((p) => p.z.toFixed(2)));
    expect([...zs].sort()).toEqual(["0.05", "10.00", "19.95"]);
  });

  it("goes both ways off the plane when symmetric", () => {
    const pts = sweepProbePoints([disc(10, 0)], 8, true);
    expect(pts.some((p) => p.z > 0)).toBe(true);
    expect(pts.some((p) => p.z < 0)).toBe(true);
  });

  it("pulls outline points inside the profile so they are not on its edge", () => {
    const pts = sweepProbePoints([disc(10, 0)], 5, false);
    const radii = pts.map((p) => Math.hypot(p.x, p.y));
    expect(Math.max(...radii)).toBeLessThan(10);
    expect(Math.max(...radii)).toBeGreaterThan(9.5);
  });

  it("samples a dense outline sparsely", () => {
    const pts = sweepProbePoints([disc(10, 0, 512)], 5, false);
    expect(pts.length).toBeLessThanOrEqual((1 + 8) * 3);
  });

  it("asks nothing of a zero depth", () => {
    expect(sweepProbePoints([disc(10, 0)], 0, false)).toEqual([]);
  });
});
