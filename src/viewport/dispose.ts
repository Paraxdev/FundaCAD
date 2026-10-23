// WebGL resources are not garbage collected, so every geometry, material and texture a rebuild drops is disposed here.

import * as THREE from "three";

export function disposeObject(root: THREE.Object3D) {
  root.traverse((o: any) => {
    // geometry.dispose() does not free the BVH, so missing this leaks a tree per rebuild.
    if (o.geometry?.boundsTree) o.geometry.disposeBoundsTree?.();
    o.geometry?.dispose?.();

    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k in m) {
        const v = m[k];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose?.();
    }
  });
}
