<script setup lang="ts">
// The axis bars and the test cube are imperative, written at device report rate and at 60 fps through plain element
// handles and never a ref. onUnmounted frees the renderer, its geometries and materials and the rAF.

import * as THREE from "three";
import { onMounted, onUnmounted, shallowRef, useTemplateRef, type ComponentPublicInstance } from "vue";
import {
  AXIS_LABELS,
  AXIS_NAMES,
  ACTION_LABELS,
  filterMotion,
  getLatestMotion,
  getSpaceMouseConfig,
  onSpaceMouseMotion,
  setSpaceMouseConfig,
  settings,
  type ActionName,
  type AxisBinding,
  type AxisName,
  type Motion,
} from "./spacemouse";

const ACTIONS = Object.keys(ACTION_LABELS) as ActionName[];

// shallowRef replaced wholesale: setSpaceMouseConfig merges the bindings into its module CONFIG, and a deep ref would
// put reactive proxies there.
const binds = shallowRef<Record<ActionName, AxisBinding>>(structuredClone(getSpaceMouseConfig().bind));

const offSettings = settings.onChange(() => {
  binds.value = structuredClone(getSpaceMouseConfig().bind);
});

function applyBind(action: ActionName, patch: Partial<AxisBinding>) {
  const next: AxisBinding = { ...binds.value[action], ...patch };
  binds.value = { ...binds.value, [action]: next };
  // Safe as a partial, and so is the cast: setSpaceMouseConfig merges `bind` per action.
  setSpaceMouseConfig({ bind: { [action]: next } as unknown as Record<ActionName, AxisBinding> });
}

// Not a ref, so updateBars can write three style properties per axis at device report rate without a render.
const bars: Partial<Record<AxisName, HTMLDivElement>> = {};
function setBar(a: AxisName, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLDivElement) bars[a] = el;
  else delete bars[a];
}

// The bar shows the RAW count (the Rust side conditions nothing), its colour what the app did with it: muted under the
// deadzone, dimmed when the cross-axis filter dropped it, full accent when it drives the camera.
function updateBars(m: Motion) {
  const SCALE = 350; // raw axis range is roughly +/-350
  const cfg = getSpaceMouseConfig();
  const f = filterMotion(m, cfg);
  for (const a of AXIS_NAMES) {
    const bar = bars[a];
    if (!bar) continue;
    const v = Math.max(-1, Math.min(1, m[a] / SCALE));
    bar.style.width = `${Math.abs(v) * 50}%`;
    bar.style.left = v >= 0 ? "50%" : `${50 - Math.abs(v) * 50}%`;
    const dead = Math.abs(m[a]) < cfg.deadzone;
    const suppressed = !dead && f[a] === 0;
    bar.style.background = dead ? "var(--text-mute, #6b7280)" : "var(--accent, #ff7a3c)";
    bar.style.opacity = suppressed ? "0.35" : "1";
    const note = suppressed ? `${AXIS_LABELS[a]}: suppressed by the cross-axis filter` : "";
    if (note) {
      bar.setAttribute("title", note);
      bar.setAttribute("aria-label", note);
    } else {
      bar.removeAttribute("title");
      bar.removeAttribute("aria-label");
    }
  }
}

const testCanvas = useTemplateRef<HTMLCanvasElement>("testCanvas");

let three: {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  cam: THREE.PerspectiveCamera;
  cube: THREE.Group;
  right: THREE.Vector3;
  up: THREE.Vector3;
} | null = null;
let raf = 0;
let unsub: (() => void) | null = null;
let lastMotion: Motion = getLatestMotion();
let lastT = 0;
let clock = 0;

function initTest(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.width, canvas.height, false);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(40, canvas.width / canvas.height, 0.1, 100);
  cam.up.set(0, 0, 1);
  cam.position.set(4, -5, 3.5);
  cam.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202428, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, -4, 6);
  scene.add(key);
  const cube = new THREE.Group();
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial({ color: 0x9aa3af, metalness: 0.1, roughness: 0.6 }),
  );
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(box.geometry),
    new THREE.LineBasicMaterial({ color: 0xff7a3c }),
  );
  cube.add(box, edges);
  // a marker on +X so rotation is obvious
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 16),
    new THREE.MeshStandardMaterial({ color: 0xff7a3c }),
  );
  dot.position.set(1, 0, 0);
  cube.add(dot);
  scene.add(cube);
  three = {
    renderer,
    scene,
    cam,
    cube,
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 0, 1),
  };
}

function disposeTest() {
  if (!three) return;
  three.scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.LineSegments)) return;
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
  });
  // dispose() alone does not release the WebGL context, a browser grants only a handful and the real viewport holds one
  // for good.
  three.renderer.forceContextLoss();
  three.renderer.dispose();
  three = null;
}

function tickTest() {
  const t = three;
  if (!t) return;
  const now = performance.now();
  const dt = Math.min(50, now - lastT);
  lastT = now;
  const cfg = getSpaceMouseConfig();
  const stale = now - clock > cfg.staleMs;
  const m = stale ? { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 } : lastMotion;
  // The same conditioning the viewport loop runs, so the preview and the real view cannot disagree.
  const f = filterMotion(m, cfg);
  const val = (a: ActionName) => {
    const b = cfg.bind[a];
    if (!b) return 0;
    return (b.invert ? -1 : 1) * f[b.src];
  };

  // Every mapped action drives the cube: rotate accumulates, pan and zoom nudge then spring back. The cube shows what the
  // model appears to do, the inverse of the camera motion, so its sign is -modeSign, checked against the real viewport.
  const ms = cfg.mode === "object" ? 1 : -1;
  const kr = cfg.orbitSens * dt * 50;
  const az = ms * val("orbitAz") * kr;
  const pol = ms * val("orbitPolar") * kr;
  const fwd = t.cam.getWorldDirection(new THREE.Vector3());
  const right = fwd.clone().cross(t.up).normalize();
  const screenUp = right.clone().cross(fwd).normalize();
  if (az) t.cube.rotateOnWorldAxis(t.up, az);
  if (pol) t.cube.rotateOnWorldAxis(right, pol);
  const rollc = ms * val("roll") * kr;
  if (rollc) t.cube.rotateOnWorldAxis(fwd, rollc); // bank around the view axis

  // A gentle gain and a hard clamp keep the cube inside the preview, this is a feel test and not a 1:1 move.
  const kp = cfg.panSens * dt * 30; // v2 sens are ~100× smaller (view-proportional)
  t.cube.position
    .addScaledVector(right, ms * val("panX") * kp)
    // vertical pan is inverted vs the model's truck convention (Pan ←→ isn't)
    .addScaledVector(screenUp, -ms * val("panY") * kp);
  const PAN_LIMIT = 1.3;
  if (t.cube.position.length() > PAN_LIMIT) t.cube.position.setLength(PAN_LIMIT);
  // The per-frame step is bounded so a hard push cannot invert the cube to a negative scale.
  const zd = THREE.MathUtils.clamp(val("zoom") * cfg.zoomSens * dt * 430, -0.08, 0.08);
  if (zd) t.cube.scale.multiplyScalar(1 + zd); // +zoom dollies in on the model → cube grows

  const decay = Math.min(1, 0.07 * (dt / 16));
  t.cube.position.multiplyScalar(1 - decay);
  const s = THREE.MathUtils.clamp(t.cube.scale.x + (1 - t.cube.scale.x) * decay, 0.6, 1.6);
  t.cube.scale.setScalar(s);

  t.renderer.render(t.scene, t.cam);
}

onMounted(() => {
  if (testCanvas.value) initTest(testCanvas.value);
  unsub = onSpaceMouseMotion((m) => {
    lastMotion = m;
    clock = performance.now();
    updateBars(m);
  });
  lastT = performance.now();
  const tick = () => {
    raf = requestAnimationFrame(tick);
    tickTest();
  };
  raf = requestAnimationFrame(tick);
});

onUnmounted(() => {
  offSettings();
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  unsub?.();
  unsub = null;
  disposeTest();
});
</script>

<template>
  <div class="sm-grid" data-spacemouse-section>
    <div class="sm-col">
      <div class="sm-section">Live axes, move the puck</div>
      <div class="sm-hint">Push/tilt/twist and watch which bar reacts, then map it beside.</div>
      <div v-for="a in AXIS_NAMES" :key="a" class="sm-axis-row">
        <span class="sm-axis-label">{{ AXIS_LABELS[a] }}</span>
        <div class="sm-axis-track">
          <div class="sm-axis-bar" :ref="(el) => setBar(a, el)"></div>
        </div>
      </div>
      <div class="sm-section">Test, rotate the cube</div>
      <canvas ref="testCanvas" class="sm-test" width="240" height="170"></canvas>
    </div>

    <div class="sm-col">
      <div class="sm-section">Axis mapping</div>
      <div v-for="action in ACTIONS" :key="action" class="sm-map-row">
        <span class="sm-map-label">{{ ACTION_LABELS[action] }}</span>
        <select
          class="sm-select"
          :value="binds[action].src"
          @change="applyBind(action, { src: ($event.target as HTMLSelectElement).value as AxisName })"
        >
          <option v-for="ax in AXIS_NAMES" :key="ax" :value="ax">{{ AXIS_LABELS[ax] }}</option>
        </select>
        <label class="sm-inv">
          <input
            type="checkbox"
            :checked="binds[action].invert"
            @change="applyBind(action, { invert: ($event.target as HTMLInputElement).checked })"
          />
          flip
        </label>
      </div>
    </div>
  </div>
</template>
