<script setup lang="ts">
// 3D-Mouse settings modal: calibrate the SpaceMouse without guessing the
// hardware. Shows a LIVE raw-axis readout (push/twist the puck → see which axis
// moves), lets you bind each camera action to any axis + invert + set
// sensitivity, and a TEST CUBE driven by the puck (with the current mapping) so
// you can confirm the feel. All edits apply live and persist.
//
// Two halves, deliberately kept apart:
//
//   * the FORM (mode, sensitivities, mappings) is ordinary reactive state,
//     mirrored out of the persisted config and written straight back;
//   * the READOUT (six axis bars + the WebGL test cube) is imperative. It runs
//     at device report rate and at 60 fps respectively, writes styles directly
//     through plain element handles, and never touches a ref. Pushing that
//     through reactivity would be a per-frame render for no benefit.
//
// The renderer, its scene resources and the rAF are all torn down in
// onUnmounted. The class this replaces cancelled the rAF and disposed the
// renderer but left the box/edges/sphere geometries and their materials on the
// GPU — and "Reset to defaults" rebuilt the whole dialog, so it leaked a full
// set every time it was pressed.

import * as THREE from "three";
import { onMounted, onUnmounted, ref, shallowRef, useTemplateRef, type ComponentPublicInstance } from "vue";
import { useDialogStore } from "../../stores/dialogs";
import ModalFrame from "./ModalFrame.vue";
import {
  AXIS_LABELS,
  AXIS_NAMES,
  ACTION_LABELS,
  filterMotion,
  getLatestMotion,
  getSpaceMouseConfig,
  onSpaceMouseMotion,
  resetSpaceMouseConfig,
  setSpaceMouseConfig,
  type ActionName,
  type AxisBinding,
  type AxisName,
  type Motion,
  type SpaceMouseConfig,
} from "../../input/spacemouse";

const dialogs = useDialogStore();
const close = () => { dialogs.spaceMouse = false; };

// NOTE: deliberately no useModalGate() here. The imperative version never
// counted itself in the modal-depth gate either, so global shortcuts have
// always stayed live behind this dialog. Adding the gate would be a behaviour
// change, and this commit is a move.

const ACTIONS = Object.keys(ACTION_LABELS) as ActionName[];

// --- form state, mirrored out of the persisted config ---
type SensKey = "panSens" | "zoomSens" | "orbitSens" | "deadzone" | "crossAxis";
interface SliderDef {
  key: SensKey;
  label: string;
  min: number;
  max: number;
  step: number;
  /** How the number reads beside the slider, when it is not the raw value. */
  format?: (v: number) => string;
  /** One line under the row, for a control whose name does not explain it. */
  hint?: string;
}

const SLIDERS: SliderDef[] = [
  { key: "panSens", label: "Pan", min: 0, max: 0.000003, step: 0.000003 / 100 },
  { key: "zoomSens", label: "Zoom", min: 0, max: 0.0000035, step: 0.0000035 / 100 },
  { key: "orbitSens", label: "Rotate", min: 0, max: 0.00001, step: 0.00001 / 100 },
  { key: "deadzone", label: "Deadzone", min: 0, max: 200, step: 1 },
  // Cross-axis filter, shown as a percentage of the strongest axis. 0 turns it
  // off. Capped at 60: past that a deliberate combined gesture stops working
  // long before the filter buys anything more.
  {
    key: "crossAxis",
    label: "Cross-axis filter",
    min: 0,
    max: 60,
    step: 1,
    format: (v) => `${Math.round(v)}%`,
    hint: "Ignores a weak axis while another axis is much stronger, so a hard tilt doesn't also zoom.",
  },
];

/** The slider's own units, which for the cross-axis filter is a percentage of
 *  the stored fraction. Kept here so the row and the config never drift. */
const toSlider = (k: SensKey, v: number) => (k === "crossAxis" ? Math.round(v * 100) : v);
const fromSlider = (k: SensKey, v: number) => (k === "crossAxis" ? v / 100 : v);

const mode = ref<SpaceMouseConfig["mode"]>("object");
const sens = ref<Record<SensKey, number>>(
  { panSens: 0, zoomSens: 0, orbitSens: 0, deadzone: 0, crossAxis: 0 },
);
// shallowRef and replace-wholesale: the bindings are handed straight back to
// setSpaceMouseConfig, which merges them into the module-level CONFIG object.
// A deep ref would put reactive proxies in there.
const binds = shallowRef<Record<ActionName, AxisBinding>>(structuredClone(getSpaceMouseConfig().bind));

function syncFromConfig() {
  const c = getSpaceMouseConfig();
  mode.value = c.mode;
  sens.value = {
    panSens: c.panSens, zoomSens: c.zoomSens, orbitSens: c.orbitSens,
    deadzone: c.deadzone, crossAxis: toSlider("crossAxis", c.crossAxis),
  };
  binds.value = structuredClone(c.bind);
}
syncFromConfig();

function setMode(m: SpaceMouseConfig["mode"]) {
  mode.value = m;
  setSpaceMouseConfig({ mode: m });
}

function setSens(key: SensKey, raw: string) {
  const v = parseFloat(raw);
  sens.value = { ...sens.value, [key]: v };
  setSpaceMouseConfig({ [key]: fromSlider(key, v) } as Partial<SpaceMouseConfig>);
}

function applyBind(action: ActionName, patch: Partial<AxisBinding>) {
  const next: AxisBinding = { ...binds.value[action], ...patch };
  binds.value = { ...binds.value, [action]: next };
  // A one-action patch. setSpaceMouseConfig merges `bind` per action rather
  // than replacing it, which is why this partial is safe (and why the cast is).
  setSpaceMouseConfig({ bind: { [action]: next } as unknown as Record<ActionName, AxisBinding> });
}

/** Reset re-reads the config in place. The class closed and reopened itself,
 *  which tore down and rebuilt the WebGL context for a settings change. */
function resetDefaults() {
  resetSpaceMouseConfig();
  syncFromConfig();
}

function fmt(v: number): string {
  if (v === 0) return "0";
  if (Math.abs(v) >= 1) return String(Math.round(v));
  return v.toPrecision(2);
}

// --- live axis bars (imperative: written at device report rate) ---
// A plain object, NOT a ref: these handles exist only so updateBars can write
// three style properties per axis without a render.
const bars: Partial<Record<AxisName, HTMLDivElement>> = {};
function setBar(a: AxisName, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLDivElement) bars[a] = el;
  else delete bars[a];
}

// The bar always shows the RAW count the device sent (the Rust side conditions
// nothing), and its colour says what the app then did with it: muted = under the
// deadzone, dimmed = the cross-axis filter dropped it because another axis is
// much stronger, full accent = it is driving the camera.
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

// --- test cube (imperative: THREE.WebGLRenderer + its own rAF) ---
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
  // dispose() alone does not release the WebGL context, and a browser only
  // grants a handful of them. The dialog is reopenable, and the real viewport
  // holds one of those slots permanently.
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
  // the SAME conditioning the viewport loop runs, so the preview and the real
  // view can never disagree about what the puck is saying
  const f = filterMotion(m, cfg);
  const val = (a: ActionName) => {
    const b = cfg.bind[a];
    if (!b) return 0; // tolerate a missing binding instead of crashing the loop
    return (b.invert ? -1 : 1) * f[b.src];
  };

  // Drive the cube with EVERY mapped action so any gesture gives feedback:
  // rotate accumulates (the thing being tested); pan/zoom nudge then spring
  // back so they read as "live while held". Gains are scaled up from the
  // camera sensitivities so motion is visible at this small size.
  // Rotate — sign mirrors object mode (the cube IS the object).
  // The cube shows what the MODEL appears to do = the inverse of the camera
  // motion the real loop applies (which carries modeSign). So the cube
  // coefficient is -modeSign: +1 in object mode, -1 in camera mode. Verified
  // against the real viewport so the cube and model move the same screen way.
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

  // Pan — nudge in the screen plane, then spring back. Gentle gain + a hard
  // clamp so the cube can never leave the little preview (this is a feel test,
  // not a 1:1 move).
  const kp = cfg.panSens * dt * 30; // v2 sens are ~100× smaller (view-proportional)
  t.cube.position
    .addScaledVector(right, ms * val("panX") * kp)
    // vertical pan is inverted vs the model's truck convention (Pan ←→ isn't)
    .addScaledVector(screenUp, -ms * val("panY") * kp);
  const PAN_LIMIT = 1.3;
  if (t.cube.position.length() > PAN_LIMIT) t.cube.position.setLength(PAN_LIMIT);
  // Zoom — scale gently; bound the per-frame step so a hard push can't invert
  // the cube (negative scale).
  const zd = THREE.MathUtils.clamp(val("zoom") * cfg.zoomSens * dt * 430, -0.08, 0.08);
  if (zd) t.cube.scale.multiplyScalar(1 + zd); // +zoom dollies in on the model → cube grows

  // Spring pan + zoom back toward home so they read as "live while held".
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
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  unsub?.();
  unsub = null;
  disposeTest();
});
</script>

<template>
  <ModalFrame @close="close()">
    <template #title>3D Mouse Settings</template>

    <div class="modal-body sm-grid">
      <!-- left column: live axes + test cube -->
      <div class="sm-col">
        <div class="sm-section">Live axes, move the puck</div>
        <div class="sm-hint">Push/tilt/twist and watch which bar reacts, then map it below.</div>
        <div v-for="a in AXIS_NAMES" :key="a" class="sm-axis-row">
          <span class="sm-axis-label">{{ AXIS_LABELS[a] }}</span>
          <div class="sm-axis-track">
            <div class="sm-axis-bar" :ref="(el) => setBar(a, el)"></div>
          </div>
        </div>
        <div class="sm-section">Test, rotate the cube</div>
        <canvas ref="testCanvas" class="sm-test" width="240" height="170"></canvas>
      </div>

      <!-- right column: mode, sensitivities, mappings -->
      <div class="sm-col">
        <div class="sm-section">Mode</div>
        <div class="sm-row">
          <label class="sm-radio">
            <input type="radio" name="sm-mode" :checked="mode === 'object'" @change="setMode('object')" />
            Move object
          </label>
          <label class="sm-radio">
            <input type="radio" name="sm-mode" :checked="mode === 'camera'" @change="setMode('camera')" />
            Move camera
          </label>
        </div>

        <div class="sm-section">Sensitivity</div>
        <div v-for="s in SLIDERS" :key="s.key" class="sm-row">
          <span class="sm-slabel">{{ s.label }}</span>
          <input
            type="range"
            :min="s.min"
            :max="s.max"
            :step="s.step"
            :value="sens[s.key]"
            @input="setSens(s.key, ($event.target as HTMLInputElement).value)"
          />
          <span class="sm-sval">{{ (s.format ?? fmt)(sens[s.key]) }}</span>
          <div v-if="s.hint" class="sm-hint sm-srow-hint">{{ s.hint }}</div>
        </div>

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

    <div class="modal-foot">
      <button class="btn" @click="resetDefaults()">Reset to defaults</button>
      <button class="btn btn-primary" @click="close()">Done</button>
    </div>
  </ModalFrame>
</template>
