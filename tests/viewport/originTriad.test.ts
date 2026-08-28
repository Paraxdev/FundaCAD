// The origin arrows as a CONTROL, not just a marker: Revolve asks which axis to
// spin about by having you click one of them, so a raycast has to be able to say
// which arm it hit and a hover has to be able to light it.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { OriginTriad } from "../../src/viewport/scene";
import { EDGE_HOVER_COLOR } from "../../src/viewport/highlight";

/** Every material the arm paints with, drawn and occluded pass alike. */
function armColors(arm: THREE.Object3D): number[] {
  const out: number[] = [];
  arm.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if (m && m.visible && m.color) out.push(m.color.getHex());
  });
  return out;
}

describe("OriginTriad", () => {
  it("tags each arm with the axis it stands for", () => {
    const triad = new OriginTriad(new THREE.Scene());
    expect(triad.arms.map((a) => a.userData.axis)).toEqual(["X", "Y", "Z"]);
    triad.dispose();
  });

  it("points each arm down its own axis", () => {
    const triad = new OriginTriad(new THREE.Scene());
    // Built along +Y and turned onto the axis, so the arm's local up is the axis.
    const up = new THREE.Vector3(0, 1, 0);
    const dirs = triad.arms.map((a) => up.clone().applyQuaternion(a.quaternion));
    expect(dirs[0]!.x).toBeCloseTo(1, 6);
    expect(dirs[1]!.y).toBeCloseTo(1, 6);
    expect(dirs[2]!.z).toBeCloseTo(1, 6);
    triad.dispose();
  });

  it("is hit through a sleeve wider than the shaft it draws", () => {
    const triad = new OriginTriad(new THREE.Scene());
    triad.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(
      // Aimed a little to the SIDE of the X arm's centre line: on the sleeve,
      // off the shaft. A shaft a pixel and a half wide is not an aimable target.
      new THREE.Vector3(44, 3, 40),
      new THREE.Vector3(0, 0, -1),
    );
    const hit = ray.intersectObjects(triad.arms, true)[0];
    expect(hit).toBeTruthy();
    let axis: unknown = null;
    for (let o: THREE.Object3D | null = hit!.object; o; o = o.parent) {
      if (o.userData?.axis) { axis = o.userData.axis; break; }
    }
    expect(axis).toBe("X");
    triad.dispose();
  });

  it("must fail without the sleeve: the drawn shaft alone is not that wide", () => {
    // The control for the test above. The shaft's radius is 0.017 of an 88-unit
    // arm, about 1.5 units, so a ray 3 units off the axis misses it — which is
    // exactly why the sleeve exists.
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(88 * 0.017, 88 * 0.017, 88, 10),
      new THREE.MeshBasicMaterial(),
    );
    shaft.position.set(44, 0, 0);
    shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0));
    shaft.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(
      new THREE.Vector3(44, 3, 40),
      new THREE.Vector3(0, 0, -1),
    );
    expect(ray.intersectObject(shaft, false)).toHaveLength(0);
  });

  it("lights only the hovered arm, and puts it back", () => {
    const triad = new OriginTriad(new THREE.Scene());
    const base = triad.arms.map(armColors);
    triad.highlight("Y");
    expect(armColors(triad.arms[1]!).every((c) => c === EDGE_HOVER_COLOR)).toBe(true);
    expect(armColors(triad.arms[0]!)).toEqual(base[0]);
    expect(armColors(triad.arms[2]!)).toEqual(base[2]);
    triad.highlight(null);
    expect(triad.arms.map(armColors)).toEqual(base);
    triad.dispose();
  });
});
