// While a fillet or chamfer is edited from History: the bodies before it, faint and never picked, over the result,
// and a guide along the rims the blend made, so the edit shows what it changes.

import * as THREE from "three";
import { GhostLines } from "./ghostLines";
import { edgeSelectColor } from "../viewport/highlight";
import { themeColor } from "../viewport/themeColors";
import type { BodyMesh } from "../viewport/render";
import type { EdgeRef } from "../viewport/edgeLines";

type Vec3 = [number, number, number];

interface Host {
  domElement: HTMLElement;
  addToScene(o: THREE.Object3D): void;
  removeFromScene(o: THREE.Object3D): void;
  requestRender(): void;
}

export const GHOST_OPACITY = 0.14;
export const GUIDE_OPACITY = 0.55;
export const GUIDE_PX = 1.6;

export class BlendEditGhost {
  private readonly group = new THREE.Group();
  private readonly material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: GHOST_OPACITY,
    depthWrite: false,
    // Pushed back so the result wins where the two surfaces agree and only what the blend took away shows.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  private guide: GhostLines | null = null;
  private shown = false;

  constructor(private readonly host: Host) {
    this.group.renderOrder = 997;
  }

  /** `bodies` are the held bodies the result replaced, `rims` the result edges the model before has no edge for. */
  show(bodies: readonly BodyMesh[], rims: readonly EdgeRef[]) {
    this.clear();
    this.material.color.setHex(themeColor("--text", 0xe8e4f0));
    for (const b of bodies) {
      const m = new THREE.Mesh(b.mesh.geometry, this.material);
      m.matrixAutoUpdate = false;
      m.matrix.copy(b.mesh.matrixWorld);
      m.renderOrder = 997;
      this.group.add(m);
    }
    if (rims.length) {
      this.guide ??= new GhostLines(this.host, { width: GUIDE_PX, opacity: GUIDE_OPACITY, depthTest: true });
      const color = edgeSelectColor();
      for (const r of rims) this.guide.add(r.points as Vec3[], color);
      this.guide.sync();
    }
    if (!this.shown && this.group.children.length) {
      this.host.addToScene(this.group);
      this.shown = true;
    }
    this.host.requestRender();
  }

  get ghostCount(): number {
    return this.group.children.length;
  }

  private clear() {
    this.group.clear();
    this.guide?.dispose();
    this.guide = null;
  }

  dispose() {
    this.clear();
    if (this.shown) this.host.removeFromScene(this.group);
    this.shown = false;
    this.material.dispose();
    this.host.requestRender();
  }
}
