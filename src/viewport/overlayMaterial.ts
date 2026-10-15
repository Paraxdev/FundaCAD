import type * as THREE from "three";

/** Mark a viewport helper's material (gizmo, outline, marker, sketch line) as an
 *  overlay. Note: three sorts by material alone, draws only its opaque list into
 *  the texture glass refracts, and draws transparent items after glass. A helper
 *  flagged transparent looks the same at opacity 1, but glass no longer shows a
 *  refracted copy of it or paints over it. */
export function overlayMaterial<M extends THREE.Material>(m: M): M {
  m.transparent = true;
  return m;
}
