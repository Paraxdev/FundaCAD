// The WebGL frame drawn over a traced image: bodies fill depth only, so edges,
// the grid and everything else rasterised are hidden behind them exactly as in
// Realtime, and the canvas is cleared to alpha 0 so the trace shows through.

import * as THREE from "three";
import { isCostlyLight } from "../potato";

function isBodyMesh(o: THREE.Object3D): o is THREE.Mesh {
  return (o as THREE.Mesh).isMesh === true && !!o.userData.owner;
}

export class OverlayDraw {
  readonly depthOnly = new THREE.MeshBasicMaterial({
    colorWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  private swapped: { mesh: THREE.Mesh; was: THREE.Material | THREE.Material[] }[] = [];
  private hidden: THREE.Object3D[] = [];
  private clear = new THREE.Color();

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.swapped.length = 0;
    this.hidden.length = 0;
    const shadows = renderer.shadowMap;
    const autoUpdate = shadows.autoUpdate;
    renderer.getClearColor(this.clear);
    const alpha = renderer.getClearAlpha();
    const override = scene.overrideMaterial;
    try {
      scene.traverseVisible((o) => this.visit(o));
      shadows.autoUpdate = false;
      scene.overrideMaterial = null;
      renderer.setClearColor(this.clear, 0);
      renderer.render(scene, camera);
    } finally {
      scene.overrideMaterial = override;
      renderer.setClearColor(this.clear, alpha);
      shadows.autoUpdate = autoUpdate;
      for (const { mesh, was } of this.swapped) mesh.material = was;
      for (const o of this.hidden) o.visible = true;
      this.swapped.length = 0;
      this.hidden.length = 0;
    }
  }

  private visit(o: THREE.Object3D) {
    if (isCostlyLight(o)) {
      o.visible = false;
      this.hidden.push(o);
      return;
    }
    if (!isBodyMesh(o)) return;
    this.swapped.push({ mesh: o, was: o.material });
    o.material = this.depthOnly;
  }

  dispose() {
    this.depthOnly.dispose();
  }
}
