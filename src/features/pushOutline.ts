import * as THREE from "three";
import { chainLoops, type SweepRing, type V3 } from "./sweepOutline";
import type { Viewport } from "../viewport/viewport";

export const PARALLEL_COS = Math.cos((1 * Math.PI) / 180);
// Edge ends of one model meet exactly, this only absorbs float noise
const CHAIN_TOL = 0.01;

export interface PushFaces {
  rings: SweepRing[];
  /** A point on each face, found again after a preview to tell which face it became. */
  marks: THREE.Vector3[];
}

type Source = Pick<Viewport, "planarFace" | "edgesOfFaces" | "faceTriangles">;

/** The closed edge rings of faces that are all flat and share `normal` within a degree, or null when any is curved,
 *  slanted off it or has no closed ring: a rigid move has an outline, anything else keeps the engine's preview. */
export function planarPushFaces(viewport: Source, faceIds: readonly number[], normal: THREE.Vector3): PushFaces | null {
  const rings: SweepRing[] = [];
  const marks: THREE.Vector3[] = [];
  for (const id of faceIds) {
    const plane = viewport.planarFace(id);
    if (!plane || Math.abs(plane.normal.clone().normalize().dot(normal)) < PARALLEL_COS) return null;
    const own = chainLoops(
      viewport.edgesOfFaces([id], { all: true }).map((e): V3[] => e.points),
      CHAIN_TOL,
    );
    const mark = largestCentroid(viewport.faceTriangles(id));
    if (!own.length || !mark) return null;
    rings.push(...own);
    marks.push(mark);
  }
  return rings.length ? { rings, marks } : null;
}

function largestCentroid(tris: readonly THREE.Triangle[]): THREE.Vector3 | null {
  let best: THREE.Triangle | null = null;
  for (const t of tris) if (!best || t.getArea() > best.getArea()) best = t;
  return best ? best.getMidpoint(new THREE.Vector3()) : null;
}
