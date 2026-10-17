// Imported panoramas decoded and ready to light with, by hash.

import * as THREE from "three";
import { downscaleEquirect, LIGHTING_HDR_WIDTH, toHalfRgba, type HdrImage } from "./hdrImage";

export interface HeldHdr {
  hash: string;
  name: string;
  light: HdrImage;
}

const KEEP = 3;
const held = new Map<string, HeldHdr>();
const listeners = new Set<(hash: string) => void>();

export function registerHdr(hash: string, name: string, img: HdrImage): HeldHdr {
  const h: HeldHdr = { hash, name, light: downscaleEquirect(img, LIGHTING_HDR_WIDTH) };
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

/** The panorama on the inside of a sphere, so the Realtime PMREM and the Path
 *  traced cube both take it exactly like a built in room. Three's equirect is
 *  Y up and this world is Z up, so the sphere is tipped a quarter turn, then
 *  turned `rotationDeg` about Z. Exposure is the material's gain. */
export function hdrRoom(h: HeldHdr, rotationDeg: number, exposure: number): { scene: THREE.Scene; dispose(): void } {
  const { width, height } = h.light;
  const half = toHalfRgba(h.light);
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
  mat.color.setScalar(2 ** exposure);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;
  const turn = new THREE.Group();
  turn.rotation.z = THREE.MathUtils.degToRad(rotationDeg);
  turn.add(mesh);
  const scene = new THREE.Scene();
  scene.add(turn);
  return {
    scene,
    dispose: () => { geo.dispose(); mat.dispose(); tex.dispose(); },
  };
}
