import type * as THREE from "three";

/** Note: three draws only its opaque list into the texture glass refracts, and transparent items after
 *  glass, so a helper flagged transparent looks the same but glass no longer refracts or covers it. */
export function overlayMaterial<M extends THREE.Material>(m: M): M {
  m.transparent = true;
  return m;
}
