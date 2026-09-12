// The little sphere beside a material's name.
//
// A REAL render, by the same renderer class and the same tone mapping the
// viewport uses, rather than a CSS gradient dressed up as one. The two things a
// swatch has to answer are "is this shiny" and "is this see-through", and a flat
// square cannot answer either: a coloured square is the same square whether the
// material is chalk or chrome. A lit sphere answers both in one glance, which is
// why every renderer in the world shows one.
//
// STANDARDISED, and that is the point of doing it here instead of in the
// viewport. Every preview is lit identically, from the same angle, against the
// same ground, whatever the document's own brightness or environment happen to
// be set to. Comparing two finishes is only possible when the only thing that
// differs between the two pictures is the finish.
//
// ONE renderer, one scene, one sphere, reused for every material and kept for
// the life of the process: a WebGL context is expensive to create and browsers
// cap how many may exist, so a context per swatch would fall over on a library
// of twenty. Each preview is a render into that one canvas followed by a
// toDataURL, and the results are cached by what the material LOOKS like, so a
// library with six shades of the same plastic renders six times and a list
// scrolled up and down renders none.

import * as THREE from "three";
import { finishOf, type MaterialDef } from "../document/materials";
import { applyClearcoat, applyGlassLook } from "./render";

/** Rendered at this many pixels square, then shown at whatever size the CSS
 *  asks for. Deliberately larger than the ~56px it is drawn at: this is one
 *  render into one canvas, and a swatch that goes soft on a high-DPI screen
 *  reads as a bitmap somebody stretched. */
const SIZE = 160;

/** What a material looks like, as a string. Two materials with the same answer
 *  render to the same picture, so the cache is keyed on this rather than on the
 *  id: a copy of a material is not a second render, and RENAMING one is not a
 *  cache miss. */
export function previewKey(m: MaterialDef): string {
  const f = finishOf(m);
  return [m.color, f.metalness, f.roughness, f.opacity, f.emissive, f.clearcoat].join("|");
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
const cache = new Map<string, string>();
const ready = new Set<() => void>();

/** The ground the sphere sits against: a soft top-to-bottom gradient, drawn
 *  once into a 2D canvas and used as the scene background.
 *
 *  Not the panel's own colour, and not the theme's. A preview whose background
 *  followed the app would change every time the theme did, so two screenshots of
 *  the same material would not match and neither would two swatches sitting side
 *  by side in different panels. This is a photographer's sweep: one fixed, mid
 *  grey backdrop that flatters neither a light material nor a dark one. */
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
      // Read back with toDataURL immediately after the render. Without this the
      // browser is free to have cleared the buffer by then, and the swatch comes
      // back blank on exactly the machines that clear most eagerly.
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

  // The rig, fixed forever: a key from the upper left (the streak that says
  // "polished"), a cool fill from below right so the dark side is not black, and
  // a little ambient so a matt material still shows its colour.
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

/** Reflections, so a metal is not a black ball.
 *
 *  Asynchronous (a dynamic import plus a cubemap render), and every preview
 *  drawn before it lands is drawn without it, which is exactly what the viewport
 *  does with the same environment and for the same reason. When it arrives the
 *  cache is dropped and the subscribers are told, so the swatches redraw once
 *  with reflections instead of the panel waiting on a texture to show a list. */
let envLoading = false;
async function loadEnvironment(): Promise<void> {
  if (envLoading || !rig) return;
  envLoading = true;
  try {
    const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
    const pmrem = new THREE.PMREMGenerator(rig.renderer);
    rig.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
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

/** A data: URL of `m` rendered as a lit sphere, or null when this machine would
 *  not give us a context. Cached by appearance, so calling it per row per frame
 *  is a map lookup. */
export function materialPreview(m: MaterialDef): string | null {
  const k = previewKey(m);
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const r = build();
  if (!r) return null;

  const f = finishOf(m);
  r.material.color.set(m.color);
  r.material.metalness = f.metalness;
  r.material.roughness = f.roughness;
  applyClearcoat(r.material, f.clearcoat);
  // A clear, non-metal finish previews as real glass too (refraction against the
  // room environment), so the swatch matches what the body will look like.
  if (!applyGlassLook(r.material, f.opacity, f.metalness, false)) {
    r.material.opacity = f.opacity;
    r.material.transparent = f.opacity < 1;
    r.material.depthWrite = f.opacity >= 1;
  }
  // The emissive tint is the material's OWN colour, as the viewport does it, so
  // a lit indicator previews as a glowing ball of the right hue rather than a
  // white one. There is no bloom out here, so the slider shows as a surface that
  // does not go dark on its shaded side.
  r.material.emissive.set(f.emissive > 0 ? m.color : 0x000000);
  r.material.emissiveIntensity = f.emissive;
  r.material.needsUpdate = true;

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
