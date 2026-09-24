// The origin marker is passive everywhere but Revolve's axis pick, which asks
// which axis to spin about by having you click one of its arms, so a raycast
// has to be able to say which arm it hit and a hover has to be able to light it.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  AXIS_COLOR, OriginTriad, TRIAD_OPACITY, mutedAxisColor,
} from "../../src/viewport/originTriad";
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

  it("draws nothing a hand would reach for: no heads, nothing opaque", () => {
    const triad = new OriginTriad(new THREE.Scene());
    triad.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      expect(mesh.geometry?.type).not.toBe("ConeGeometry");
      const m = mesh.material as THREE.MeshBasicMaterial | undefined;
      if (m && m.visible) {
        expect(m.transparent).toBe(true);
        expect(m.opacity).toBeLessThanOrEqual(TRIAD_OPACITY);
      }
    });
    triad.dispose();
  });

  it("mutes the axis colours but keeps each one's hue", () => {
    const channels = (h: number) => [(h >> 16) & 0xff, (h >> 8) & 0xff, h & 0xff];
    for (const [c, top] of [[AXIS_COLOR.x, 0], [AXIS_COLOR.y, 1], [AXIS_COLOR.z, 2]] as const) {
      const before = channels(c);
      const after = channels(mutedAxisColor(c));
      const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
      expect(spread(after)).toBeLessThan(spread(before));
      expect(after.indexOf(Math.max(...after))).toBe(top);
    }
    expect(mutedAxisColor(0x808080)).toBe(0x808080);
    expect(mutedAxisColor(AXIS_COLOR.x, 0)).toBe(AXIS_COLOR.x);
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
      // off the drawn line.
      new THREE.Vector3(32, 3, 40),
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

  it("must fail without the sleeve: the drawn line alone is not that wide", () => {
    const triad = new OriginTriad(new THREE.Scene());
    triad.group.updateMatrixWorld(true);
    const drawn = triad.arms[0]!.children.filter(
      (o) => ((o as THREE.Mesh).material as THREE.Material).visible,
    );
    const ray = new THREE.Raycaster(new THREE.Vector3(32, 3, 40), new THREE.Vector3(0, 0, -1));
    expect(ray.intersectObjects(drawn, false)).toHaveLength(0);
    triad.dispose();
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
