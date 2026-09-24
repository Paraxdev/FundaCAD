import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { aimFollow, aimPoint } from "../../src/features/aimStalk";
import { aimedAngles } from "../../src/features/lightAimTool";
import { keyDirection } from "../../src/viewport/keyLight";

const down = new THREE.Vector3(0, 0, -1);
const centre = new THREE.Vector3(0, 0, 0);

describe("aimPoint", () => {
  it("takes the side of the sphere facing the camera", () => {
    const ray = new THREE.Ray(new THREE.Vector3(0, 0, 10), down);
    expect(aimPoint(ray, centre, 2).toArray()).toEqual([0, 0, 2]);
  });

  it("follows a ray that misses onto the outline beneath it", () => {
    const p = aimPoint(new THREE.Ray(new THREE.Vector3(5, 0, 10), down), centre, 2);
    expect(p.length()).toBeCloseTo(2, 12);
    expect(p.x).toBeCloseTo(2, 12);
    expect(p.z).toBeCloseTo(0, 12);
  });
});

describe("aimFollow", () => {
  it("turns the direction by exactly what the cursor swept over the sphere", () => {
    const from = aimPoint(new THREE.Ray(new THREE.Vector3(0, 0, 10), down), centre, 2).normalize();
    const now = aimPoint(new THREE.Ray(new THREE.Vector3(0, 1, 10), down), centre, 2).normalize();
    const d = aimFollow(new THREE.Vector3(1, 0, 0), from, now);
    expect(d.length()).toBeCloseTo(1, 12);
    expect(d.x).toBeCloseTo(1, 12);
    const tip = aimFollow(new THREE.Vector3(0, 0, 1), from, now);
    expect((Math.acos(tip.z) * 180) / Math.PI).toBeCloseTo(30, 9);
  });

  it("a press that has not moved leaves the direction as it was", () => {
    const from = new THREE.Vector3(0.6, 0, 0.8);
    const d = aimFollow(new THREE.Vector3(0.3, -0.4, 0.866).normalize(), from, from.clone());
    expect(d.toArray().map((x) => +x.toFixed(9))).toEqual(new THREE.Vector3(0.3, -0.4, 0.866).normalize().toArray().map((x) => +x.toFixed(9)));
  });
});

describe("aimedAngles", () => {
  const start = { azimuth: -55, elevation: 45 };
  const tip = new THREE.Vector3(...keyDirection(start.azimuth, start.elevation));

  it("swinging the sun round the up axis moves only the azimuth, snapped", () => {
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (32 * Math.PI) / 180);
    const a = aimedAngles(start, tip, tip.clone().applyQuaternion(turn), 5);
    expect(a).toEqual({ azimuth: -25, elevation: 45 });
  });

  it("Shift steps a degree, Alt leaves it free", () => {
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (32.4 * Math.PI) / 180);
    const now = tip.clone().applyQuaternion(turn);
    expect(aimedAngles(start, tip, now, 1).azimuth).toBe(-23);
    expect(aimedAngles(start, tip, now, 0).azimuth).toBeCloseTo(-22.6, 9);
  });

  it("lifting it towards the zenith raises the elevation, never past straight up", () => {
    const side = new THREE.Vector3(...keyDirection(start.azimuth + 90, 0));
    const lift = (deg: number) => tip.clone().applyAxisAngle(side, (-deg * Math.PI) / 180);
    expect(aimedAngles(start, tip, lift(20), 5)).toEqual({ azimuth: -55, elevation: 65 });
    expect(aimedAngles(start, tip, lift(60), 5).elevation).toBeLessThanOrEqual(90);
  });
});
