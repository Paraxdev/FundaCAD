// The guides a round face resize draws: where the axis line runs and where the
// dashed size line starts, which is what tells a radius from a diameter on the model.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { axialSpan, axisLine, ResizeGuides, sizeLine, type GuideHost } from "../../src/features/resizeGuides";
import type { Vec3 } from "../../src/types";

// The c1 slot end: a half cylinder of r 2 along X on y 7.125, z 20, x 0 to 25.
const SLOT_AXIS = { origin: [12, 7.125, 20] as Vec3, dir: [1, 0, 0] as Vec3 };
const SLOT_HANDLE: Vec3 = [3, 9.125, 20];

const close = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9));

describe("axialSpan", () => {
  it("measures the face along the axis from its origin", () => {
    const pts: Vec3[] = [
      [0, 9.125, 20],
      [25, 7.125, 22],
      [10, 5.125, 20],
    ];
    expect(axialSpan(pts, SLOT_AXIS)).toEqual([-12, 13]);
  });

  it("has no span without points", () => {
    expect(axialSpan([], SLOT_AXIS)).toBeNull();
  });
});

describe("axisLine", () => {
  it("runs past the face by 15 percent of its length, half at each end", () => {
    const [a, b] = axisLine(SLOT_AXIS, [-12, 13]);
    close(a, [-1.875, 7.125, 20]);
    close(b, [26.875, 7.125, 20]);
  });
});

describe("sizeLine", () => {
  it("runs from the axis foot to the handle for a radius", () => {
    const [a, b] = sizeLine(SLOT_HANDLE, SLOT_AXIS, false);
    close(a, [3, 7.125, 20]);
    close(b, SLOT_HANDLE);
  });

  it("runs from the opposite wall through the axis for a diameter", () => {
    const [a, b] = sizeLine(SLOT_HANDLE, SLOT_AXIS, true);
    close(a, [3, 5.125, 20]);
    close(b, SLOT_HANDLE);
  });
});

describe("ResizeGuides", () => {
  const host = () => {
    const scene: THREE.Object3D[] = [];
    let renders = 0;
    const h: GuideHost = {
      addToScene: (o) => void scene.push(o),
      removeFromScene: (o) => void scene.splice(scene.indexOf(o), 1),
      pixelWorldSize: () => 0.02,
      requestRender: () => void renders++,
    };
    return { h, scene, renders: () => renders };
  };
  const ends = (line: THREE.Line | null): number[] => [
    ...(line!.geometry.getAttribute("position").array as Float32Array),
  ];

  it("draws a solid axis line and a dashed size line with screen sized dashes", () => {
    const { h, scene } = host();
    const g = new ResizeGuides();
    g.update(h, { axis: SLOT_AXIS, span: [-12, 13], handle: new THREE.Vector3(...SLOT_HANDLE), full: false });
    expect(scene.map((o) => o.name)).toEqual(["resize-axis", "resize-size"]);
    expect(g.axisLine!.material).toBeInstanceOf(THREE.LineBasicMaterial);
    expect(g.axisLine!.material).not.toBeInstanceOf(THREE.LineDashedMaterial);
    const dashed = g.sizeLine!.material as THREE.LineDashedMaterial;
    expect(dashed).toBeInstanceOf(THREE.LineDashedMaterial);
    expect(dashed.dashSize).toBeCloseTo(0.1);
    expect(ends(g.sizeLine)).toEqual([3, 7.125, 20, 3, 9.125, 20]);
    expect(g.sizeLine!.geometry.getAttribute("lineDistance").getX(1)).toBeCloseTo(2);
  });

  it("only asks for a render when something moved, and takes both lines down on clear", () => {
    const { h, scene, renders } = host();
    const g = new ResizeGuides();
    const s = {
      axis: SLOT_AXIS,
      span: [-12, 13] as [number, number],
      handle: new THREE.Vector3(...SLOT_HANDLE),
      full: true,
    };
    g.update(h, s);
    const after = renders();
    g.update(h, s);
    expect(renders()).toBe(after);
    g.update(h, { ...s, handle: new THREE.Vector3(3, 9.5, 20) });
    expect(renders()).toBe(after + 1);
    expect(ends(g.sizeLine)).toEqual([3, 4.75, 20, 3, 9.5, 20]);
    g.clear();
    expect(scene).toEqual([]);
    expect(g.axisLine).toBeNull();
  });

  // The 4g6g19j9 fillet: ends a float32 buffer cannot hold exactly redrew every frame after the drag.
  it("asks for no render on a repeat of ends a float32 cannot hold exactly", () => {
    const { h, renders } = host();
    const g = new ResizeGuides();
    const s = {
      axis: { origin: [18.551, 0.003, 26.066] as Vec3, dir: [0, 0, 1] as Vec3 },
      span: [-26.066, 26.066] as [number, number],
      handle: new THREE.Vector3(43.591, 24.295, 34.755),
      full: false,
    };
    g.update(h, s);
    const after = renders();
    for (let i = 0; i < 10; i++) g.update(h, s);
    expect(renders()).toBe(after);
  });
});
