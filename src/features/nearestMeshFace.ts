import * as THREE from "three";
import type { RebuildResult, Vec3 } from "../types";

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();
const closest = new THREE.Vector3();
const query = new THREE.Vector3();
const tri = new THREE.Triangle();

/** The face of body `bodyId` nearest `point` in a built mesh, null when that body is not in it. */
export function nearestMeshFace(
  result: RebuildResult,
  bodyId: string,
  point: Vec3,
): { faceId: number; distance: number } | null {
  const body = result.bodies?.find((x) => x.id === bodyId);
  if (!body) return null;
  const { positions, indices, faceIds } = result.mesh;
  query.set(point[0], point[1], point[2]);
  let best: { faceId: number; distance: number } | null = null;
  for (let t = 0; t < faceIds.length; t++) {
    const faceId = faceIds[t] ?? -1;
    if (faceId < body.faceStart || faceId >= body.faceStart + body.faceCount) continue;
    const at = (k: number) => (indices[t * 3 + k] ?? 0) * 3;
    a.fromArray(positions as number[], at(0));
    b.fromArray(positions as number[], at(1));
    c.fromArray(positions as number[], at(2));
    tri.set(a, b, c).closestPointToPoint(query, closest);
    const distance = closest.distanceTo(query);
    if (!best || distance < best.distance) best = { faceId, distance };
  }
  return best;
}
