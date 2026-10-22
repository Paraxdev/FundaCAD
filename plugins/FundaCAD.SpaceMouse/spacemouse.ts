// The Tauri side reads the device (src-tauri/src/spacemouse.rs), here motion drives the camera rig. The axis mapping is
// user data because which physical axis is which differs per device and orientation.

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
  // "object": the puck moves the model (3Dconnexion default), "camera": the puck flies the camera.
  mode: "object" | "camera";
  deadzone: number; // ignore |axis| below this (jitter)
  // Drops an axis below this fraction of the strongest mapped axis, 0 is off. A hard tilt leaks ~30 counts onto the
  // neighbours, which a higher deadzone could not drop without killing slow input.
  crossAxis: number;
  // pan and zoom scale with rig.viewScale(), the visible view height, so a deflection moves the same fraction of the
  // screen at any zoom. Fixed world steps felt ~100x too fast at mm detail.
  panSens: number; // fraction-of-view per axis-unit per ms
  zoomSens: number; // ln(zoom-factor) per axis-unit per ms
  orbitSens: number; // radians per axis-unit per ms
  staleMs: number; // no event for this long ⇒ motion treated as zero
  sensVersion?: number; // bump when sens semantics change (see loadConfig)
  // Each camera action takes one raw axis, all six mapped by default. Ry, the sideways tilt, drives roll as 3Dconnexion
  // does.
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

// v1 world-unit defaults, to migrate stored configs while keeping the user's ratio to them.
const V1_PAN_DEFAULT = 0.00006;
const V1_ZOOM_DEFAULT = 0.0001;

// A crossAxis of 1 or more silences every axis, a puck that looks dead, so a garbled or hand edited value is clamped on
// load and on set.
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

/** Shared by the viewport loop and the settings preview. The deadzone runs first, which matters only once CROSS_AXIS_MAX
 *  reaches 1. The peak counts mapped axes only and the comparison is strict, so the strongest axis always survives. */
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
      // Migrate v1 world-unit pan and zoom sens to v2, keeping the user's multiplier relative to the old defaults.
      if ((saved.sensVersion ?? 1) < 2) {
        if (typeof saved.panSens === "number") {
          cfg.panSens = (saved.panSens / V1_PAN_DEFAULT) * DEFAULTS.panSens;
        }
        if (typeof saved.zoomSens === "number") {
          cfg.zoomSens = (saved.zoomSens / V1_ZOOM_DEFAULT) * DEFAULTS.zoomSens;
        }
        cfg.sensVersion = 2;
      }
      // Rebuilt from defaults and merged per action, so a partial or stale stored bind cannot leave an action unbound
      // and crash whatever reads its `.src`.
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

export function setSpaceMouseMode(mode: "object" | "camera") {
  settings.set("mode", mode);
}

// The raw motion stream, for the settings readout and the test cube.
let latest: Motion = ZERO;
const motionListeners = new Set<(m: Motion) => void>();
export function getLatestMotion(): Motion {
  return latest;
}
export function onSpaceMouseMotion(fn: (m: Motion) => void): () => void {
  motionListeners.add(fn);
  return () => motionListeners.delete(fn);
}

/** The teardown must stop the frame loop, or a stale motion vector keeps drifting the view while the capability is off.
 *  Safe to call twice. */
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

  // The caller may tear this down during the await, so check here as well as in the loop.
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
    // Conditioned once per frame, so two actions bound to the same axis cannot disagree about it.
    const m = filterMotion(raw, CONFIG);
    // object mode manipulates the model → inverse of camera mode on pan + orbit
    const modeSign = CONFIG.mode === "object" ? -1 : 1;
    const b = CONFIG.bind;

    // panScreen works in half view heights and zoomBy multiplies, so both stay proportional to the view.
    const px = val(b.panX, m),
      py = val(b.panY, m);
    if (px || py) {
      viewport.rig.panScreen(modeSign * px * CONFIG.panSens * dt, modeSign * py * CONFIG.panSens * dt);
    }
    const z = val(b.zoom, m); // direction is its own preference, not mode-dependent
    // exp(-z): positive axis kept as zoom-IN (old dolly(+z)); zoomBy(>1) = out
    if (z) viewport.rig.zoomBy(Math.exp(-z * CONFIG.zoomSens * dt));

    // Sketch mode locks orbit on the rig, read here rather than pushed in, so sketching need not import the 3D mouse.
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
    // Cleared, so the settings readout and the test cube see a device at rest.
    latest = ZERO;
  };
}
