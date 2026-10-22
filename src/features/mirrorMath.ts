import * as THREE from "three";
import type { Feature, Plane3, PlaneDef } from "../types";
import { SketchPlane } from "../sketch/plane";
import type { FacePlanePick } from "./facePlanePick";

export type MirrorPlanePick =
  | { kind: "base"; plane: Plane3 }
  | { kind: "datum"; id: string; def: PlaneDef }
  | { kind: "face"; face: FacePlanePick };

export function basePlaneDef(p: Plane3): PlaneDef {
  const sp = new SketchPlane(p);
  return { origin: [0, 0, 0], normal: [sp.n.x, sp.n.y, sp.n.z], xdir: [sp.u.x, sp.u.y, sp.u.z] };
}

export function planeDefOf(pick: MirrorPlanePick): PlaneDef {
  if (pick.kind === "base") return basePlaneDef(pick.plane);
  return pick.kind === "datum" ? pick.def : pick.face.def;
}

/** The reflection across `def`, as the engine's kernel::mirrored does it: x' = x - 2 ((x - o) . n) n. */
export function reflectionMatrix(def: PlaneDef): THREE.Matrix4 {
  const n = new THREE.Vector3(...def.normal).normalize();
  const d = 2 * n.dot(new THREE.Vector3(...def.origin));
  const { x, y, z } = n;
  // prettier-ignore
  return new THREE.Matrix4().set(
    1 - 2 * x * x, -2 * x * y, -2 * x * z, d * x,
    -2 * x * y, 1 - 2 * y * y, -2 * y * z, d * y,
    -2 * x * z, -2 * y * z, 1 - 2 * z * z, d * z,
    0, 0, 0, 1,
  );
}

export const FACE_DATUM_NAME = "Mirror plane";

/** The features one Mirror commit adds. The plane is always `{ name }`, the form the engine takes with `bodies`. A
 *  face becomes a datum plane first, which follows the face through upstream edits and stays editable. */
export function mirrorFeatures(nextId: () => string, bodies: readonly string[], pick: MirrorPlanePick): Feature[] {
  const mirror = (name: string): Feature => ({ id: nextId(), type: "mirror", plane: { name }, bodies: [...bodies] });
  if (pick.kind === "base") return [mirror(pick.plane)];
  if (pick.kind === "datum") return [mirror(pick.id)];
  const datum: Feature = {
    id: nextId(),
    type: "datumPlane",
    plane: pick.face.def,
    offset: 0,
    face: pick.face.selector,
    name: FACE_DATUM_NAME,
  };
  return [datum, mirror(datum.id)];
}
