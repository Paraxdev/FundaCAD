// Imported panoramas decoded and ready to light with, by hash.

import * as THREE from "three";
import { downscaleEquirect, toHalfRgba, type HdrImage } from "./hdrImage";
import { experimentalPrefs, lightingEnvWidth, storedEnvWidth } from "../ui/experimentalPrefs";

export interface HeldHdr {
  hash: string;
  name: string;
  light: HdrImage;
}

const KEEP = 3;
/** The renderer's largest texture side, told by the scene once it has a context. */
let textureMax = 8192;

export function setHdrTextureMax(side: number) {
  if (side > 0) textureMax = side;
}

export function hdrTextureMax(): number {
  return textureMax;
}

/** The width an imported panorama is kept and embedded at: 2048 unless Preferences, Experimental says more. */
export function hdrStoredWidth(): number {
  return storedEnvWidth(experimentalPrefs(), textureMax);
}

/** The width the lighting reads, half the stored one. */
export function hdrLightingWidth(): number {
  return lightingEnvWidth(experimentalPrefs(), textureMax);
}
const held = new Map<string, HeldHdr>();
const listeners = new Set<(hash: string) => void>();

export function registerHdr(hash: string, name: string, img: HdrImage): HeldHdr {
  const h: HeldHdr = { hash, name, light: downscaleEquirect(img, hdrLightingWidth()) };
  held.delete(hash);
  held.set(hash, h);
  while (held.size > KEEP) held.delete(held.keys().next().value!);
  for (const fn of listeners) fn(hash);
  return h;
}

export function heldHdr(hash: string): HeldHdr | null {
  return held.get(hash) ?? null;
}

export function onHdrRegistered(fn: (hash: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** On the inside of a sphere, so the Realtime PMREM and the traced cube take it like a built in room. Tipped a quarter
 *  turn (three's equirect is Y up), then turned `rotationDeg` about Z; exposure is baked in. */
export function hdrRoom(h: HeldHdr, rotationDeg: number, exposure: number): { scene: THREE.Scene; dispose(): void } {
  const { width, height } = h.light;
  const half = toHalfRgba(h.light, 2 ** exposure);
  // Rows flipped here rather than with flipY, which a data texture does not honour everywhere.
  const rows = new Uint16Array(half.length);
  const stride = width * 4;
  for (let y = 0; y < height; y++) rows.set(half.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
  const tex = new THREE.DataTexture(rows, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  const geo = new THREE.SphereGeometry(50, 96, 48);
  geo.scale(-1, 1, 1);
  const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;
  const turn = new THREE.Group();
  turn.rotation.z = THREE.MathUtils.degToRad(rotationDeg);
  turn.add(mesh);
  const scene = new THREE.Scene();
  scene.add(turn);
  return {
    scene,
    dispose: () => {
      geo.dispose();
      mat.dispose();
      tex.dispose();
    },
  };
}
