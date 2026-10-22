import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { basePlaneDef, mirrorFeatures, planeDefOf, reflectionMatrix } from "../../src/features/mirrorMath";
import type { PlaneDef } from "../../src/types";
import type { FacePlanePick } from "../../src/features/facePlanePick";

const at = (m: THREE.Matrix4, p: [number, number, number]) => {
  const v = new THREE.Vector3(...p).applyMatrix4(m);
  return [v.x, v.y, v.z].map((c) => +c.toFixed(9) + 0);
};

describe("basePlaneDef", () => {
  it("gives each origin plane its normal through the origin", () => {
    expect(basePlaneDef("XY")).toEqual({ origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] });
    expect(basePlaneDef("XZ")).toEqual({ origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] });
    expect(basePlaneDef("YZ")).toEqual({ origin: [0, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0] });
  });
});

describe("reflectionMatrix", () => {
  const p: [number, number, number] = [3.5, -7.25, 12];

  it.each([
    ["XY", [3.5, -7.25, -12]],
    ["XZ", [3.5, 7.25, 12]],
    ["YZ", [-3.5, -7.25, 12]],
  ] as const)("reflects across %s", (plane, want) => {
    expect(at(reflectionMatrix(basePlaneDef(plane)), p)).toEqual(want);
  });

  // A plane 7.5 off the origin, tilted 20 degrees about X: normal (0, sin 20, cos 20) through 7.5 n.
  const t = (20 * Math.PI) / 180;
  const n: [number, number, number] = [0, Math.sin(t), Math.cos(t)];
  const tilted: PlaneDef = { origin: [n[0] * 7.5 + 4, n[1] * 7.5, n[2] * 7.5], normal: n, xdir: [1, 0, 0] };

  it("reflects across a tilted plane off the origin", () => {
    const m = reflectionMatrix(tilted);
    const dist = new THREE.Vector3(...p).dot(new THREE.Vector3(...n)) - 7.5;
    const want = new THREE.Vector3(...p).addScaledVector(new THREE.Vector3(...n), -2 * dist);
    expect(at(m, p)).toEqual([want.x, want.y, want.z].map((c) => +c.toFixed(9) + 0));
    // A point on the plane stays put.
    expect(at(m, tilted.origin)).toEqual(tilted.origin.map((c) => +c.toFixed(9) + 0));
  });

  it("flips handedness and undoes itself", () => {
    for (const def of [basePlaneDef("XY"), basePlaneDef("YZ"), tilted]) {
      const m = reflectionMatrix(def);
      expect(m.determinant()).toBeCloseTo(-1, 12);
      const twice = m.clone().multiply(m).elements;
      new THREE.Matrix4().elements.forEach((e, i) => expect(twice[i]).toBeCloseTo(e, 12));
    }
  });

  it("takes a normal that is not unit length", () => {
    const long: PlaneDef = { origin: [0, 0, 2.5], normal: [0, 0, 4], xdir: [1, 0, 0] };
    expect(at(reflectionMatrix(long), [1.5, -2, 9])).toEqual([1.5, -2, -4]);
  });
});

describe("mirrorFeatures", () => {
  const ids = () => {
    let n = 41;
    return () => `f${n++}`;
  };

  it("names an origin plane for one body", () => {
    expect(mirrorFeatures(ids(), ["body3"], { kind: "base", plane: "XZ" })).toEqual([
      { id: "f41", type: "mirror", plane: { name: "XZ" }, bodies: ["body3"] },
    ]);
  });

  it("names a datum plane by id for several bodies", () => {
    const def: PlaneDef = { origin: [2, 5, -1], normal: [0.6, 0, 0.8], xdir: [0, 1, 0] };
    const bodies = ["body1", "body4", "body2"];
    const out = mirrorFeatures(ids(), bodies, { kind: "datum", id: "f7", def });
    expect(out).toEqual([{ id: "f41", type: "mirror", plane: { name: "f7" }, bodies: ["body1", "body4", "body2"] }]);
    // The feature holds its own copy of the list.
    bodies.pop();
    expect(out[0]).toMatchObject({ bodies: ["body1", "body4", "body2"] });
  });

  it("puts a datum plane on a flat face first, and mirrors across it", () => {
    const face: FacePlanePick = {
      def: { origin: [-8, 2.5, 3], normal: [0, 0.6, -0.8], xdir: [1, 0, 0] },
      kind: "planar",
      selector: { kind: "face", by: "nearest", point: [-8, 2.5, 3], body: "body2" },
      faceId: 19,
      at: [-8, 2.5, 3],
    };
    expect(mirrorFeatures(ids(), ["body2", "body5"], { kind: "face", face })).toEqual([
      { id: "f41", type: "datumPlane", plane: face.def, offset: 0, face: face.selector, name: "Mirror plane" },
      { id: "f42", type: "mirror", plane: { name: "f41" }, bodies: ["body2", "body5"] },
    ]);
    expect(planeDefOf({ kind: "face", face })).toBe(face.def);
  });

  it("reads the def of either pick", () => {
    const def: PlaneDef = { origin: [2, 5, -1], normal: [0.6, 0, 0.8], xdir: [0, 1, 0] };
    expect(planeDefOf({ kind: "datum", id: "f7", def })).toBe(def);
    expect(planeDefOf({ kind: "base", plane: "YZ" })).toEqual(basePlaneDef("YZ"));
  });
});
