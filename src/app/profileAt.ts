import * as THREE from "three";
import { regionBeatsSurface } from "../sketch/regionOverSurface";
import { regionArea } from "../sketch/region";
import type { WorldRegion } from "../sketch/overlay";
import type { Engine } from "./engine";

/** The visible sketch profile a click there picks, or null when the face in front of it, or the face it traces, gets
 *  the click (sketch/regionOverSurface.ts). With `refresh`, cut lines that landed under a tool apply first; an open
 *  tool holding the areas passes false, a fresh split would leave it holding areas no longer on screen. */
export function createProfileAt(
  e: Pick<Engine, "overlay" | "viewport" | "store">,
  opts: { refresh: boolean } = { refresh: true },
): (x: number, y: number) => WorldRegion | null {
  // A face's area only changes with a rebuild, and hover asks on every move.
  const faceAreas = new Map<number, number>();
  e.store.onBuild(() => faceAreas.clear());
  return (x, y) => {
    if (opts.refresh && e.overlay.splitStale) {
      e.overlay.update(e.store.document);
      e.viewport.requestRender();
    }
    const ray = e.viewport.rayFrom(x, y).ray;
    const wr = e.overlay.committedRegionAtRay(ray);
    if (!wr) return null;
    const onPlane = ray.intersectPlane(wr.plane.plane, new THREE.Vector3());
    const surface = e.viewport.surfaceHitAt(x, y);
    if (!onPlane || !surface) return wr;
    let faceArea = 0;
    if (surface.faceId !== null) {
      faceArea = faceAreas.get(surface.faceId) ?? e.viewport.faceArea(surface.faceId);
      faceAreas.set(surface.faceId, faceArea);
    }
    return regionBeatsSurface({
      regionDist: onPlane.distanceTo(ray.origin),
      surfaceDist: surface.distance,
      modelScale: e.viewport.modelDiagonal() ?? 0,
      regionArea: regionArea(wr.region),
      faceArea,
    })
      ? wr
      : null;
  };
}
