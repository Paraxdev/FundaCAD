// Matcap view mode's draw. For the length of one render every body's PBR
// material is swapped for a MeshMatcapMaterial twin, the emitter lights are
// hidden and the shadow maps are left as they are, then everything is put back.
// The real materials are never written to, so leaving Matcap brings glass,
// emission, clearcoat and surfaces back exactly, and nothing is rebuilt.
//
// Drawn straight to the current target in one call: no composer, no glass back
// pass, no shadow pass, and the canvas keeps its multisampling.

import * as THREE from "three";
import { isCostlyLight, isPbr, mirror } from "./potato";

/** A twin nobody has drawn for this many matcap frames is disposed. */
const PRUNE_AFTER_FRAMES = 30;

export const MATCAP_SIZE = 256;

/** The matcap tops out at 1, so the rest of the match to Realtime's brightness
 *  is a gain on the twin's colour. */
export const MATCAP_GAIN = 1.7;

let studio: THREE.DataTexture | null = null;

function srgbByte(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** A lit grey sphere, made once on the CPU and kept for the session. The light
 *  levels were matched in the browser against Realtime under Neutral tone
 *  mapping, so a painted body keeps about the same brightness in both modes. */
export function studioMatcap(): THREE.DataTexture {
  if (studio) return studio;
  const n = MATCAP_SIZE;
  const data = new Uint8Array(n * n * 4);
  const key = new THREE.Vector3(-0.45, 0.65, 0.62).normalize();
  const fill = new THREE.Vector3(0.7, -0.15, 0.7).normalize();
  const half = new THREE.Vector3(0, 0, 1).add(key).normalize();
  const nrm = new THREE.Vector3();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n) * 2 - 1;
      const y = ((j + 0.5) / n) * 2 - 1;
      const r2 = x * x + y * y;
      if (r2 >= 1) nrm.set(x, y, 0).normalize();
      else nrm.set(x, y, Math.sqrt(1 - r2));
      const sky = 0.5 + 0.5 * nrm.y;
      const diffuse = Math.max(0, nrm.dot(key));
      const soft = Math.max(0, nrm.dot(fill));
      const spec = Math.pow(Math.max(0, nrm.dot(half)), 40);
      const rim = Math.pow(1 - nrm.z, 3);
      const v = 0.36 + 0.2 * sky + 0.45 * diffuse + 0.22 * soft + 0.2 * spec + 0.06 * rim;
      const b = srgbByte(v);
      const o = (j * n + i) * 4;
      data[o] = b;
      data[o + 1] = b;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  studio = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  studio.colorSpace = THREE.SRGBColorSpace;
  studio.magFilter = THREE.LinearFilter;
  studio.minFilter = THREE.LinearFilter;
  studio.needsUpdate = true;
  return studio;
}

interface Twin { flat: THREE.MeshMatcapMaterial; seen: number }

function isBodyMesh(o: THREE.Object3D): o is THREE.Mesh {
  return (o as THREE.Mesh).isMesh === true && !!o.userData.owner;
}

export class MatcapDraw {
  private mats = new Map<THREE.Material, Twin>();
  private frame = 0;
  private brightness = 1;
  private swapped: { mesh: THREE.Mesh; was: THREE.Material | THREE.Material[] }[] = [];
  private hidden: THREE.Object3D[] = [];

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, brightness = 1) {
    this.frame++;
    this.brightness = brightness;
    this.swapped.length = 0;
    this.hidden.length = 0;
    const shadows = renderer.shadowMap as THREE.WebGLShadowMap | undefined;
    const autoUpdate = shadows?.autoUpdate;
    try {
      scene.traverseVisible((o) => this.visit(o));
      if (shadows) shadows.autoUpdate = false;
      renderer.render(scene, camera);
    } finally {
      if (shadows) shadows.autoUpdate = autoUpdate!;
      for (const { mesh, was } of this.swapped) mesh.material = was;
      for (const o of this.hidden) o.visible = true;
      this.swapped.length = 0;
      this.hidden.length = 0;
      this.prune();
    }
  }

  /** How many twins are held, for tests and diagnostics. */
  get held(): number {
    return this.mats.size;
  }

  dispose() {
    for (const t of this.mats.values()) t.flat.dispose();
    this.mats.clear();
  }

  private visit(o: THREE.Object3D) {
    if (isCostlyLight(o)) {
      o.visible = false;
      this.hidden.push(o);
      return;
    }
    if (!isBodyMesh(o) || !o.material) return;
    const was = o.material;
    if (Array.isArray(was)) {
      if (!was.some(isPbr)) return;
      o.material = was.map((m) => (isPbr(m) ? this.twin(m) : m));
    } else {
      if (!isPbr(was)) return;
      o.material = this.twin(was);
    }
    this.swapped.push({ mesh: o, was });
  }

  private twin(src: THREE.MeshStandardMaterial): THREE.MeshMatcapMaterial {
    let t = this.mats.get(src);
    if (!t) {
      t = { flat: new THREE.MeshMatcapMaterial({ matcap: studioMatcap() }), seen: 0 };
      t.flat.name = `matcap:${src.name}`;
      this.mats.set(src, t);
    }
    t.seen = this.frame;
    const c = t.flat;
    mirror(c, src);
    c.color.copy(src.color).multiplyScalar(this.brightness * MATCAP_GAIN);
    // These shape the compiled program, which three only rebuilds on a version bump.
    if (c.vertexColors !== src.vertexColors || c.flatShading !== src.flatShading || !!c.map !== !!src.map) {
      c.vertexColors = src.vertexColors;
      c.flatShading = src.flatShading;
      c.needsUpdate = true;
    }
    c.map = src.map;
    return c;
  }

  private prune() {
    for (const [src, t] of this.mats) {
      if (this.frame - t.seen > PRUNE_AFTER_FRAMES) {
        t.flat.dispose();
        this.mats.delete(src);
      }
    }
  }
}
