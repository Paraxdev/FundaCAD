// Whether anything a shadow map is drawn from changed since the last look.
//
// Every requestRender used to redraw every shadow map, and most do not need it:
// a hover, a selection, an overlay or a material edit changes no caster and no
// light. A point light's map is six depth passes over the model, so on a dense
// model that was most of every frame. The casters and the shadow lights are few
// next to the triangles behind them, so reading them each frame is cheap.

import * as THREE from "three";

export class ShadowWatch {
  private last: number[] = [];
  private now: number[] = [];

  changed(scene: THREE.Object3D): boolean {
    const v = this.now;
    v.length = 0;
    scene.updateMatrixWorld();
    scene.traverseVisible((o) => {
      if ((o as THREE.Light).isLight) {
        const shadow = (o as THREE.Light).shadow;
        if (!o.castShadow || !shadow) return;
        v.push(o.id, ...o.matrixWorld.elements, shadow.mapSize.x, shadow.bias, shadow.radius, ...shadow.camera.projectionMatrix.elements);
        const target = (o as THREE.DirectionalLight).target;
        if (target) v.push(...target.matrixWorld.elements);
        return;
      }
      if (!o.castShadow) return;
      const mesh = o as THREE.Mesh;
      const geo = mesh.geometry as THREE.BufferGeometry | undefined;
      const pos = geo?.getAttribute("position") as THREE.BufferAttribute | undefined;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      v.push(o.id, o.layers.mask, ...o.matrixWorld.elements, geo?.id ?? -1, pos?.version ?? -1, geo?.index?.version ?? -1,
        geo?.drawRange.start ?? 0, geo?.drawRange.count ?? 0, geo?.groups.length ?? 0,
        (mat as { id?: number } | undefined)?.id ?? -1, mat?.side ?? 0, mat?.shadowSide ?? -1, mat?.alphaTest ?? 0, mat?.clippingPlanes?.length ?? 0);
    });
    const same = v.length === this.last.length && v.every((x, i) => x === this.last[i]);
    this.now = this.last;
    this.last = v;
    return !same;
  }
}
