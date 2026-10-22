// The lit sphere beside a material's name: a real render with the viewport's tone mapping under one fixed rig and
// backdrop, so finishes compare. One shared WebGL context (browsers cap them), results cached by appearance.

import * as THREE from "three";
import { finishOf, type MaterialDef } from "../document/materials";
import { applyClearcoat, applyFinishFields, applyGlassLook, applyThinFilm } from "./render";
import { finishKey } from "./bodyFinish";
import { LruCache } from "../lib/lruCache";

/** Larger than the ~56px it is shown at, so a swatch stays sharp on a high DPI screen. */
const SIZE = 160;

/** The cache key, so a copy or a rename of a material is not a second render. */
export function previewKey(m: MaterialDef): string {
  return `${m.color}|${finishKey(finishOf(m))}`;
}

interface Rig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  ball: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
}

let rig: Rig | null = null;
let dead = false; // context creation failed once; stop trying
// Keyed by appearance, so every step of a slider drag is a new entry, and each
// is a PNG data URL of tens of kilobytes.
const cache = new LruCache<string, string>(160);
const ready = new Set<() => void>();

/** A fixed mid grey sweep, not the theme's colour, so swatches match across panels, themes and screenshots. */
function backdrop(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = SIZE;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, SIZE);
  grad.addColorStop(0, "#3c4046");
  grad.addColorStop(0.62, "#24272b");
  grad.addColorStop(1, "#171a1d");
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, SIZE);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function build(): Rig | null {
  if (rig) return rig;
  if (dead) return null;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      // toDataURL reads right after the render; without this some machines clear the buffer first and the swatch is blank.
      preserveDrawingBuffer: true,
    });
  } catch {
    // No context to be had (too many live, or software rendering refused). The
    // list falls back to a flat swatch rather than the panel failing to open.
    dead = true;
    return null;
  }
  renderer.setSize(SIZE, SIZE, false);
  renderer.setPixelRatio(1); // SIZE is already the pixel count
  renderer.toneMapping = THREE.NeutralToneMapping; // the viewport's, so the two agree

  const scene = new THREE.Scene();
  scene.background = backdrop();

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.set(0, 0, 4.6);

  const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), material);
  scene.add(ball);

  // Fixed forever: a key from the upper left for the polished streak, a cool fill from below right so the dark side is
  // not black, and a little ambient for matt colours.
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(-2.2, 2.6, 2.4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.9);
  fill.position.set(2.4, -1.6, 1.2);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  rig = { renderer, scene, camera, ball, material };
  void loadEnvironment();
  return rig;
}

/** Reflections, so a metal is not a black ball. Loaded async: previews drawn before it lack it, and on arrival the
 *  cache drops and subscribers redraw once. */
let envLoading = false;
async function loadEnvironment(): Promise<void> {
  if (envLoading || !rig) return;
  envLoading = true;
  try {
    const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
    const pmrem = new THREE.PMREMGenerator(rig.renderer);
    const room = new RoomEnvironment();
    rig.scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
  } catch {
    return; // no reflections; a metal reads dark, which is survivable
  }
  cache.clear();
  for (const fn of ready) fn();
}

/** Told once, when the previews have gained their reflections and are worth
 *  asking for again. */
export function onPreviewsChanged(fn: () => void): () => void {
  ready.add(fn);
  return () => ready.delete(fn);
}

/** The camera sits on +Z, so a world Z tangent would point at the viewer and the
 *  stretch would fade out of the swatch. Screen up shows it. */
const SWATCH_AXIS = new THREE.Vector3(0, 1, 0);

/** Puts `m` on the swatch ball's material. */
export function dressPreview(mat: THREE.MeshStandardMaterial, m: MaterialDef): void {
  const f = finishOf(m);
  mat.color.set(m.color);
  mat.metalness = f.metalness;
  mat.roughness = f.roughness;
  applyClearcoat(mat, f.clearcoat);
  applyThinFilm(mat, f, false);
  // A clear, non-metal finish previews as real glass too (refraction against the
  // room environment), so the swatch matches what the body will look like.
  if (!applyGlassLook(mat, f, false)) {
    mat.opacity = f.opacity;
    mat.transparent = f.opacity < 1;
    mat.depthWrite = f.opacity >= 1;
  }
  applyFinishFields(mat, f, false, m.color, SWATCH_AXIS);
  // The emissive tint is the material's own colour, as in the viewport, so a lit indicator glows its own hue. With no
  // bloom here it shows as a surface that does not go dark on its shaded side.
  mat.emissive.set(f.emissive > 0 ? m.color : 0x000000);
  mat.emissiveIntensity = f.emissive;
  mat.needsUpdate = true;
}

/** A data: URL of `m` as a lit sphere, null when this machine gives no context. Cached by appearance, so calling it
 *  per row per frame is a map lookup. */
export function materialPreview(m: MaterialDef): string | null {
  const k = previewKey(m);
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const r = build();
  if (!r) return null;

  dressPreview(r.material, m);

  r.renderer.render(r.scene, r.camera);
  let url = "";
  try {
    url = r.renderer.domElement.toDataURL("image/png");
  } catch {
    url = "";
  }
  cache.set(k, url);
  return url || null;
}

/** For tests and for a hard reset: drop the cache and the context. */
export function disposePreviews(): void {
  rig?.renderer.dispose();
  rig = null;
  dead = false;
  envLoading = false;
  cache.clear();
}
