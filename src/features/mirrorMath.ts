import * as THREE from "three";
import type { Feature, Plane3, PlaneDef } from "../types";
import { SketchPlane } from "../sketch/plane";

export type MirrorPlanePick = { kind: "base"; plane: Plane3 } | { kind: "datum"; id: string; def: PlaneDef };

export function basePlaneDef(p: Plane3): PlaneDef {
  const sp = new SketchPlane(p);
  return { origin: [0, 0, 0], normal: [sp.n.x, sp.n.y, sp.n.z], xdir: [sp.u.x, sp.u.y, sp.u.z] };
}

export function planeDefOf(pick: MirrorPlanePick): PlaneDef {
  return pick.kind === "base" ? basePlaneDef(pick.plane) : pick.def;
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

/** The features one Mirror commit adds. The plane is always `{ name }`, the form the engine takes with `bodies`. */
export function mirrorFeatures(nextId: () => string, bodies: readonly string[], pick: MirrorPlanePick): Feature[] {
  const name = pick.kind === "base" ? pick.plane : pick.id;
  return [{ id: nextId(), type: "mirror", plane: { name }, bodies: [...bodies] }];
}
