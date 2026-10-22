// 3D mouse (3Dconnexion SpaceMouse) support.
//
// The Tauri native side reads the device and streams 6DOF motion + button
// events (see src-tauri/src/spacemouse.rs). Here we map motion onto the camera
// (orbit / pan / zoom through the camera rig) and rising-edge button presses to an
// action callback. Browser/dev (no Tauri) is a no-op.
//
// The axis→action mapping is DATA-DRIVEN and user-configurable (each camera
// action binds to one of the six raw axes, with invert + sensitivity), because
// which physical axis is which differs per device/orientation. The 3D-Mouse
// Settings screen (./SpaceMouseModal.vue) edits this live with a raw-axis
// readout + a test cube; the config persists to localStorage.

import { definePluginSettings, listen, readSetting, type SettingValues, type SettingsSchema } from "fundacad";

export const PLUGIN_ID = "FundaCAD.SpaceMouse";
import type { Viewport } from "fundacad";

export interface Motion {
  tx: number;
  ty: number;
  tz: number;
  rx: number;
  ry: number;
  rz: number;
}
const ZERO: Motion = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };

export type AxisName = "tx" | "ty" | "tz" | "rx" | "ry" | "rz";
export const AXIS_NAMES: AxisName[] = ["tx", "ty", "tz", "rx", "ry", "rz"];
export const AXIS_LABELS: Record<AxisName, string> = {
  tx: "Slide ←→ (Tx)",
  ty: "Push/pull (Ty)",
  tz: "Lift ↑↓ (Tz)",
  rx: "Tilt/pitch (Rx)",
  ry: "Tilt sideways/roll (Ry)",
  rz: "Twist (Rz)",
};

export type ActionName = "panX" | "panY" | "zoom" | "orbitAz" | "orbitPolar" | "roll";
export const ACTION_LABELS: Record<ActionName, string> = {
  panX: "Pan ←→",
  panY: "Pan ↑↓",
  zoom: "Zoom",
  orbitAz: "Rotate ←→",
  orbitPolar: "Rotate ↑↓",
  roll: "Roll ↻",
};

export interface AxisBinding {
  src: AxisName;
  invert: boolean;
}

export interface SpaceMouseConfig {
  // "object" = puck manipulates the model (3Dconnexion default); "camera"
  // = puck flies the camera (inverse of object on pan + orbit).
  mode: "object" | "camera";
  deadzone: number; // ignore |axis| below this (jitter)
  // Cross-axis filter: suppress any axis below this FRACTION of the strongest
  // MAPPED axis of the same frame; 0 = off. A real puck leaks a few counts onto
  // its neighbours under a hard deflection, and once that leak clears the
  // absolute deadzone it is indistinguishable from deliberate input, a ~30
  // count push/pull leak while tilting 200 counts zoomed the view as well as
  // orbiting it. Raising the deadzone instead would kill legitimate slow input
  // for everyone.
  crossAxis: number;
  // pan/zoom are ZOOM-PROPORTIONAL (scaled by rig.viewScale(), the visible
  // view height): a puck deflection moves the view by the same FRACTION of
  // what's on screen at any zoom. Fixed world-unit steps made the puck feel
  // ~100× too fast when zoomed into mm-scale detail ("sensitivity went crazy").
  panSens: number; // fraction-of-view per axis-unit per ms
  zoomSens: number; // ln(zoom-factor) per axis-unit per ms
  orbitSens: number; // radians per axis-unit per ms
  staleMs: number; // no event for this long ⇒ motion treated as zero
  sensVersion?: number; // bump when sens semantics change (see loadConfig)
  // each camera action ← one raw axis (+ invert). All six axes map by default:
  // 3 translations (pan X/Y, zoom) + 3 rotations (yaw, pitch, roll). Ry, the
  // sideways tilt that used to be ignored, drives roll (its 3Dconnexion-
  // conventional action); every action is freely remappable in the settings UI.
  bind: Record<ActionName, AxisBinding>;
}

const DEFAULTS: SpaceMouseConfig = {
  mode: "object",
  deadzone: 24,
  crossAxis: 0.25,
  panSens: 0.0000006,
  zoomSens: 0.0000007,
  orbitSens: 0.0000022,
  staleMs: 120,
  sensVersion: 2,
  bind: {
    panX: { src: "tx", invert: false },
    panY: { src: "tz", invert: false },
    zoom: { src: "ty", invert: false },
    orbitAz: { src: "rz", invert: true },
    orbitPolar: { src: "rx", invert: false },
    roll: { src: "ry", invert: false },
  },
};

// v1 (absolute world-units) defaults, used to migrate persisted configs while
// preserving the user's tuning RATIO relative to the old defaults
const V1_PAN_DEFAULT = 0.00006;
const V1_ZOOM_DEFAULT = 0.0001;

// A crossAxis of 1 would mean "only the single strongest axis is ever heard",
// and anything above it silences EVERY axis including the strongest, a puck
// that appears completely dead, which is a far worse bug than the leak this
// filter exists to fix. So a garbled or hand-edited value is clamped, not
// trusted, both on load and on set.
const CROSS_AXIS_MAX = 0.9;
function clampCrossAxis(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULTS.crossAxis;
  return Math.min(CROSS_AXIS_MAX, Math.max(0, v));
}

/** A device the native side found but could not read. `hint` is what the user
 *  can do about it there, null where the native side has nothing better. */
export interface DeviceBlocked {
  name: string;
  detail: string;
  hint?: string | null;
}

export function blockedText(b: DeviceBlocked): string {
  const fix = b.hint || "run spacenavd or install the udev rule";
  return `Found "${b.name}" but can't read it, ${fix}, see the 3D mouse page of the manual`;
}

/** Condition one frame of raw axis counts: per-axis deadzone, then the
 *  cross-axis filter. The single source of truth, the viewport motion loop and
 *  the settings preview both call this, so they can never disagree.
 *
 *  The deadzone runs FIRST for readability, NOT for correctness: it cannot
 *  change the answer while CROSS_AXIS_MAX is below 1, because a peak under the
 *  deadzone yields a gate of at most 0.9 x deadzone, which is itself below the
 *  deadzone and so can never zero an axis the deadzone spared. Raise that clamp
 *  to 1 or above and the ordering starts to matter.
 *
 *  The peak is taken over only the axes some action is bound to, because an
 *  unmapped axis drives nothing and must not be able to silence the ones that
 *  do. The comparison is strict, so the strongest axis always survives and two
 *  equal axes both survive. */
export function filterMotion(m: Motion, cfg: SpaceMouseConfig): Motion {
  const out: Motion = { ...ZERO };
  for (const a of AXIS_NAMES) out[a] = Math.abs(m[a]) < cfg.deadzone ? 0 : m[a];

  const ratio = clampCrossAxis(cfg.crossAxis);
  if (ratio <= 0) return out;
  let peak = 0;
  for (const b of Object.values(cfg.bind ?? {})) {
    if (b) peak = Math.max(peak, Math.abs(out[b.src]));
  }
  if (peak === 0) return out;
  const gate = peak * ratio;
  for (const a of AXIS_NAMES) {
    if (Math.abs(out[a]) < gate) out[a] = 0;
  }
  return out;
}

const KEY = "fundacad.spacemouse.config";
const LEGACY_KEYS = ["neocad.spacemouse.config", "sindricad.spacemouse.config"];
const LEGACY_MODE_KEY = "sindricad.spacemouse.mode";

function readOldConfig(): SpaceMouseConfig | null {
  const cfg: SpaceMouseConfig = structuredClone(DEFAULTS);
  try {
    const raw = readSetting(KEY, ...LEGACY_KEYS);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<SpaceMouseConfig>;
      const savedBind = saved.bind;
      Object.assign(cfg, saved);
      cfg.crossAxis = clampCrossAxis(cfg.crossAxis);
      // migrate v1 (absolute world-unit) pan/zoom sens to the v2 proportional
      // semantics, keeping the user's multiplier relative to the old defaults
      if ((saved.sensVersion ?? 1) < 2) {
        if (typeof saved.panSens === "number") {
          cfg.panSens = (saved.panSens / V1_PAN_DEFAULT) * DEFAULTS.panSens;
        }
        if (typeof saved.zoomSens === "number") {
          cfg.zoomSens = (saved.zoomSens / V1_ZOOM_DEFAULT) * DEFAULTS.zoomSens;
        }
        cfg.sensVersion = 2;
      }
      // Rebuild bind from defaults and merge per-action with validation, so a
      // partial or stale-shaped persisted bind (older dev builds used different
      // action keys) can never leave an action unbound, which would crash the
      // settings UI and the motion loop reading `.src`/`.invert` of undefined.
      cfg.bind = structuredClone(DEFAULTS.bind);
      if (savedBind) {
        for (const a of Object.keys(DEFAULTS.bind) as ActionName[]) {
          const b = savedBind[a];
          if (b && AXIS_NAMES.includes(b.src)) cfg.bind[a] = { src: b.src, invert: !!b.invert };
        }
      }
    } else {
      const legacy = localStorage.getItem(LEGACY_MODE_KEY);
      if (legacy === null) return null;
      if (legacy === "camera") cfg.mode = "camera";
    }
  } catch {
    return null;
  }
  return cfg;
}

const PERCENT_MAX = 500;
// Rounded to 1e-9 only to drop float noise; an old slider value is rarely a whole percent.
const percentOf = (v: number, dflt: number) =>
  Math.min(PERCENT_MAX, Math.max(0, Math.round((v / dflt) * 100 * 1e9) / 1e9));
const sens = (key: string, label: string) =>
  ({
    key,
    type: "number",
    label,
    group: "Sensitivity",
    unit: "%",
    default: 100,
    min: 0,
    max: PERCENT_MAX,
    step: 5,
  }) as const;

function parseBind(v: unknown): Record<ActionName, AxisBinding> {
  const out = structuredClone(DEFAULTS.bind);
  if (!v || typeof v !== "object") return out;
  for (const a of Object.keys(DEFAULTS.bind) as ActionName[]) {
    const b = (v as Record<string, Partial<AxisBinding> | undefined>)[a];
    if (b && AXIS_NAMES.includes(b.src as AxisName)) out[a] = { src: b.src as AxisName, invert: !!b.invert };
  }
  return out;
}

/** The stored settings in the units the form shows: sensitivities as a share
 *  of the default, because the internal ones are per axis unit per ms. */
function valuesOf(cfg: SpaceMouseConfig): SettingValues {
  return {
    mode: cfg.mode,
    panPercent: percentOf(cfg.panSens, DEFAULTS.panSens),
    zoomPercent: percentOf(cfg.zoomSens, DEFAULTS.zoomSens),
    orbitPercent: percentOf(cfg.orbitSens, DEFAULTS.orbitSens),
    deadzone: Math.min(200, Math.max(0, Math.round(cfg.deadzone))),
    crossAxisPercent: Math.round(clampCrossAxis(cfg.crossAxis) * 100),
    bind: cfg.bind,
  };
}

export const SETTINGS: SettingsSchema = {
  version: 1,
  props: [
    {
      key: "mode",
      type: "enum",
      label: "Mode",
      description: "Object mode moves the model the way the puck moves; camera mode moves the camera instead.",
      default: DEFAULTS.mode,
      options: [
        { id: "object", label: "Object mode" },
        { id: "camera", label: "Camera mode" },
      ],
    },
    sens("panPercent", "Pan"),
    sens("zoomPercent", "Zoom"),
    sens("orbitPercent", "Rotate"),
    {
      key: "deadzone",
      type: "number",
      label: "Deadzone",
      group: "Sensitivity",
      integer: true,
      description: "How far the puck has to move before anything happens, in device counts.",
      default: DEFAULTS.deadzone,
      min: 0,
      max: 200,
      step: 1,
    },
    {
      key: "crossAxisPercent",
      type: "number",
      label: "Cross-axis filter",
      group: "Sensitivity",
      unit: "%",
      integer: true,
      description:
        "Ignores a weak axis while another axis is much stronger, so a hard tilt does not also zoom. 0 turns it off.",
      default: Math.round(DEFAULTS.crossAxis * 100),
      min: 0,
      max: Math.round(CROSS_AXIS_MAX * 100),
      step: 1,
    },
    { key: "bind", type: "data", default: DEFAULTS.bind, parse: parseBind },
  ],
  legacy: () => {
    const old = readOldConfig();
    return old ? valuesOf(old) : null;
  },
};

export const settings = definePluginSettings(PLUGIN_ID, SETTINGS);

function configOf(v: SettingValues, staleMs = DEFAULTS.staleMs): SpaceMouseConfig {
  const num = (k: string) => v[k] as number;
  return {
    ...structuredClone(DEFAULTS),
    mode: v.mode === "camera" ? "camera" : "object",
    panSens: (DEFAULTS.panSens * num("panPercent")) / 100,
    zoomSens: (DEFAULTS.zoomSens * num("zoomPercent")) / 100,
    orbitSens: (DEFAULTS.orbitSens * num("orbitPercent")) / 100,
    deadzone: num("deadzone"),
    crossAxis: num("crossAxisPercent") / 100,
    staleMs,
    bind: parseBind(v.bind),
  };
}

const CONFIG: SpaceMouseConfig = configOf(settings.all());
settings.onChange(() => Object.assign(CONFIG, configOf(settings.all(), CONFIG.staleMs)));

export function getSpaceMouseConfig(): SpaceMouseConfig {
  return CONFIG;
}

const SETTING_OF: Partial<Record<keyof SpaceMouseConfig, string>> = {
  mode: "mode",
  panSens: "panPercent",
  zoomSens: "zoomPercent",
  orbitSens: "orbitPercent",
  deadzone: "deadzone",
  crossAxis: "crossAxisPercent",
  bind: "bind",
};

/** Merge a patch into the live config and store it, in the config's own units
 *  (the devtools hook window.spaceMouseConfig({ orbitSens: 4e-6 }) uses this). */
export function setSpaceMouseConfig(patch: Partial<SpaceMouseConfig>) {
  const { bind, staleMs, ...rest } = patch;
  if (typeof staleMs === "number") CONFIG.staleMs = staleMs;
  const next = valuesOf({ ...CONFIG, ...rest, bind: { ...CONFIG.bind, ...bind } });
  // Only what the patch names: the rest would come back through valuesOf's rounding.
  const named = new Set(Object.keys(patch).map((f) => SETTING_OF[f as keyof SpaceMouseConfig]));
  for (const [k, v] of Object.entries(next)) if (named.has(k)) settings.set(k, v);
}

export function resetSpaceMouseConfig() {
  settings.reset();
}

export function getSpaceMouseMode(): "object" | "camera" {
  return CONFIG.mode;
}

// Sketch "lock to plane", suppress orbit + roll (keep pan + zoom) so the puck
// cannot tilt the view off the sketch plane, is read off the rig in the loop
// below rather than pushed here by sketch mode. Sketch mode sets the same lock
// on the rig one line earlier either way, so this asks the thing that already
// knows instead of being a second copy that has to be kept in step. It also
// means sketching does not have to import the 3D mouse to say something about
// the camera.

export function setSpaceMouseMode(mode: "object" | "camera") {
  settings.set("mode", mode);
}

// --- live raw-motion stream (for the settings readout + test cube) ---
let latest: Motion = ZERO;
const motionListeners = new Set<(m: Motion) => void>();
export function getLatestMotion(): Motion {
  return latest;
}
export function onSpaceMouseMotion(fn: (m: Motion) => void): () => void {
  motionListeners.add(fn);
  return () => motionListeners.delete(fn);
}

/** Start listening to the device and driving the view.
 *
 *  Returns a teardown. It has one, and the teardown has to actually stop the
 *  frame loop, because the 3D mouse is a capability that can be turned off
 *  while the app is running: a loop still reading a stale motion vector and
 *  calling rig.panScreen() every frame is not "off", it is a view that drifts
 *  for reasons nobody can find. Calling it twice is safe. */
export async function initSpaceMouse(viewport: Viewport, onButton: (pressedMask: number) => void): Promise<() => void> {
  if (!("__TAURI_INTERNALS__" in window)) return () => {}; // native desktop app only

  let motion: Motion = ZERO;
  let lastEvent = 0;
  let prevMask = 0;
  let stopped = false;

  const unlisten: (() => void)[] = [];
  unlisten.push(
    await listen<Motion>("spacemouse:motion", (e) => {
      motion = e.payload;
      latest = e.payload;
      lastEvent = performance.now();
      for (const fn of motionListeners) fn(e.payload);
    }),
  );
  unlisten.push(
    await listen<{ mask: number }>("spacemouse:button", (e) => {
      const pressed = e.payload.mask & ~prevMask; // rising edge only
      prevMask = e.payload.mask;
      if (pressed) onButton(pressed);
    }),
  );

  // Between the await above and the first frame below, the caller may already
  // have torn this down. Checking here as well as in the loop means a teardown
  // that lands in that window still takes effect.
  if (stopped) {
    for (const off of unlisten) off();
    return () => {};
  }

  /** signed value of the raw axis a binding points at (0 if unbound) */
  const val = (b: AxisBinding | undefined, f: Motion) => (b ? (b.invert ? -1 : 1) * f[b.src] : 0);
  let last = performance.now();

  const loop = () => {
    if (stopped) return; // do NOT re-schedule: this is what "off" means
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(50, now - last);
    last = now;

    // if the device stopped sending (missed the centering report), decay to zero
    const raw = now - lastEvent > CONFIG.staleMs ? ZERO : motion;
    // condition the whole frame ONCE, not per binding: two actions bound to the
    // same axis must never disagree about whether that axis moved
    const m = filterMotion(raw, CONFIG);
    // object mode manipulates the model → inverse of camera mode on pan + orbit
    const modeSign = CONFIG.mode === "object" ? -1 : 1;
    const b = CONFIG.bind;

    // Pan and zoom are proportional to the view (panScreen works in half view
    // heights, zoomBy multiplies), so the puck moves the view by the same
    // FRACTION of the screen at any zoom level.
    const px = val(b.panX, m),
      py = val(b.panY, m);
    if (px || py) {
      viewport.rig.panScreen(modeSign * px * CONFIG.panSens * dt, modeSign * py * CONFIG.panSens * dt);
    }
    const z = val(b.zoom, m); // direction is its own preference, not mode-dependent
    // exp(-z): positive axis kept as zoom-IN (old dolly(+z)); zoomBy(>1) = out
    if (z) viewport.rig.zoomBy(Math.exp(-z * CONFIG.zoomSens * dt));

    const locked = viewport.rig.orbitLocked();
    const az = val(b.orbitAz, m),
      pol = val(b.orbitPolar, m);
    if (!locked && (az || pol)) {
      // tumble, not the mouse's turntable orbit: the puck rotates freely over
      // the poles, matching the 3Dconnexion driver feel.
      viewport.rig.tumble(modeSign * az * CONFIG.orbitSens * dt, modeSign * pol * CONFIG.orbitSens * dt);
    }

    const roll = val(b.roll, m);
    if (!locked && roll) viewport.rig.roll(modeSign * roll * CONFIG.orbitSens * dt);
  };
  requestAnimationFrame(loop);

  return () => {
    stopped = true;
    for (const off of unlisten) off();
    unlisten.length = 0;
    // The last thing the device said, cleared. Anything reading getLatestMotion()
    // after this (the settings readout, the test cube) should see a device at
    // rest rather than whatever it was doing when it was switched off.
    latest = ZERO;
  };
}
