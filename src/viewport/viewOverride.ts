import * as THREE from "three";
import type { PlaneDef, ViewOverride } from "../types";
import { CURVED_FACE_ROW } from "../features/facePlanePick";
import { treePickRefusal, type TreePick, type TreePickAnswer } from "../ui/treePick";

// up is normal x xdir, the in-plane up of the face; straight up when xdir runs along the normal.
export function viewOverrideOf(plane: PlaneDef): ViewOverride {
  const normal = new THREE.Vector3(...plane.normal).normalize();
  const xdir = new THREE.Vector3(...plane.xdir).normalize();
  const up = new THREE.Vector3().crossVectors(normal, xdir).normalize();
  if (up.lengthSq() < 1e-6) up.set(0, 0, 1);
  return { normal: [normal.x, normal.y, normal.z], up: [up.x, up.y, up.z] };
}

/** A row has no click point, so only a flat face row sets a side: `planeOf` answers null for a curved face. */
export function overrideRowAnswer(
  pick: TreePick,
  planeOf: (faceId: number) => PlaneDef | null,
  take: (override: ViewOverride) => void,
): TreePickAnswer {
  if (pick.kind !== "face") return treePickRefusal(pick, "modelFlatFace");
  const plane = planeOf(pick.faceId);
  if (!plane) return CURVED_FACE_ROW;
  take(viewOverrideOf(plane));
  return true;
}
