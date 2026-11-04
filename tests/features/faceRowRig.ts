// Real faces for the Geometry list row tests: a slanted flat face (14) and a half cylinder (15) on body b2, a sphere
// patch (16) on b2 and a flat face off the first (23) on b3, all off the origin. Only the two viewport questions a
// face row asks are answered.

import * as THREE from "three";
import type { PressPullFaces } from "../../src/viewport/faceAnalysis";
import type { Vec3 } from "../../src/types";

export const asVec = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

const O = new THREE.Vector3(12.5, -7.25, 30);
export const SLANT_NORMAL = new THREE.Vector3(0, 0.6, 0.8);
const U = new THREE.Vector3(1, 0, 0);
const V = new THREE.Vector3().crossVectors(SLANT_NORMAL, U);
const at = (a: number, b: number, from = O) => from.clone().addScaledVector(U, a).addScaledVector(V, b);

const flatTris = [
  new THREE.Triangle(at(0, 0), at(10, 0), at(0, 6)),
  new THREE.Triangle(at(10, 0), at(10, 6), at(0, 6)),
];
export const FLAT_ANCHOR = flatTris[0]!.getMidpoint(new THREE.Vector3());

const O3 = new THREE.Vector3(-30, 14.5, 6.25);
const otherFlatTris = [new THREE.Triangle(at(0, 0, O3), at(8, 0, O3), at(0, 5, O3))];
const otherFlatAnchor = otherFlatTris[0]!.getMidpoint(new THREE.Vector3());

const AXIS = new THREE.Vector3(0, 0.6, 0.8);
const BASE = new THREE.Vector3(20, -5, 10);
const RADIAL0 = new THREE.Vector3(1, 0, 0);
const RADIAL1 = new THREE.Vector3().crossVectors(AXIS, RADIAL0);
const radial = (a: number) => RADIAL0.clone().multiplyScalar(Math.cos(a)).addScaledVector(RADIAL1, Math.sin(a));
const rim = (a: number, t: number) => BASE.clone().addScaledVector(radial(a), 4).addScaledVector(AXIS, t);
const halfCylinder: THREE.Triangle[] = [];
for (let i = 0; i < 8; i++) {
  const a0 = (Math.PI * i) / 8;
  const a1 = (Math.PI * (i + 1)) / 8;
  halfCylinder.push(
    new THREE.Triangle(rim(a0, 0), rim(a1, 0), rim(a1, 10)),
    new THREE.Triangle(rim(a0, 0), rim(a1, 10), rim(a0, 10)),
  );
}
export const CYL_NORMAL = radial(Math.PI / 2);
export const CYL_ANCHOR = rim(Math.PI / 2, 4);

const onSphere = (x: number, y: number, z: number) =>
  new THREE.Vector3(x, y, z)
    .normalize()
    .multiplyScalar(5)
    .add(new THREE.Vector3(-8, 3, 12));
const sphereTris = [
  new THREE.Triangle(onSphere(1, 0, 0), onSphere(0, 1, 0), onSphere(0, 0, 1)),
  new THREE.Triangle(onSphere(1, 0, 0), onSphere(0, 0, 1), onSphere(1, 0, -1)),
  new THREE.Triangle(onSphere(0, 1, 0), onSphere(-1, 0, 1), onSphere(0, 0, 1)),
];

const normalOf = (t: THREE.Triangle) => t.getNormal(new THREE.Vector3());

const faces: Record<number, { tris: THREE.Triangle[]; faces: PressPullFaces }> = {
  14: {
    tris: flatTris,
    faces: row(14, FLAT_ANCHOR, SLANT_NORMAL, "b2"),
  },
  15: { tris: halfCylinder, faces: row(15, CYL_ANCHOR, CYL_NORMAL, "b2") },
  16: {
    tris: sphereTris,
    faces: row(16, sphereTris[0]!.getMidpoint(new THREE.Vector3()), normalOf(sphereTris[0]!), "b2"),
  },
  23: { tris: otherFlatTris, faces: row(23, otherFlatAnchor, SLANT_NORMAL, "b3") },
};

function row(id: number, anchor: THREE.Vector3, normal: THREE.Vector3, bodyId: string): PressPullFaces {
  return {
    selectors: [{ kind: "face", by: "nearest", point: asVec(anchor), body: bodyId }],
    faceIds: [id],
    normal,
    anchor,
    bodyId,
    round: null,
    lead: null,
  };
}

/** The two answers a face row needs from a viewport; a built model is simulated by `built`. */
export function faceRowViewport(built = true) {
  const asked: number[][] = [];
  return {
    asked,
    parts: {
      facesForPressPull: (ids: readonly number[]) => (
        asked.push([...ids]),
        built ? (faces[ids[0]!]?.faces ?? null) : null
      ),
      faceTriangles: (id: number) => faces[id]?.tris ?? [],
    },
  };
}
