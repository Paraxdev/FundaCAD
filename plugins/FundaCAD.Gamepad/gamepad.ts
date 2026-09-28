// Game controller support: the bindings, the stored settings, and the arithmetic
// that turns one frame of sticks and triggers into camera motion.
//
// Nothing in here touches the DOM or the Gamepad API, so the suite can drive it
// with plain arrays. ./main.ts does the polling and the dispatching.
//
// The pad is read through the browser's Gamepad API in its "standard" layout,
// which is what an Xbox or PlayStation pad reports, and what a Steam Deck
// reports when Steam Input presents it as a controller:
//
//   buttons  0 A   1 B   2 X   3 Y   4 LB   5 RB   6 LT   7 RT
//            8 View/Back   9 Menu/Start   10 L3   11 R3
//            12 up   13 down   14 left   15 right   16 Guide
//   axes     0 left X   1 left Y   2 right X   3 right Y   (down and right +)
//
// The triggers are analog and drive zoom, so they are not bindable. Every other
// button is, to a command id from the palette, to a key, or to the cursor.

import { readSetting } from "fundacad";

/** What a button does, as one string so a <select> can hold it:
 *  ""            nothing
 *  "cursor"      turn the on-screen cursor on or off
 *  "key:<Key>"   a key press, e.g. "key:Enter", "key:Ctrl+K"
 *  anything else a command id, run through the app's dispatcher */
export type Binding = string;

export const CURSOR = "cursor";

export const BUTTON_LABELS: Record<number, string> = {
  0: "A", 1: "B", 2: "X", 3: "Y", 4: "LB", 5: "RB",
  8: "View / Back", 9: "Menu / Start", 10: "Left stick click", 11: "Right stick click",
  12: "D-pad up", 13: "D-pad down", 14: "D-pad left", 15: "D-pad right",
};
/** The buttons a binding can be set for, in the order the settings list them. */
export const BINDABLE = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15];

/** The keys offered in the settings, beside the commands. */
export const KEY_CHOICES: { value: Binding; label: string }[] = [
  { value: "key:Enter", label: "Enter (confirm)" },
  { value: "key:Escape", label: "Escape (cancel)" },
  { value: "key:Delete", label: "Delete" },
  { value: "key:Tab", label: "Tab" },
  { value: "key:Ctrl+K", label: "Command palette" },
];

export interface GamepadConfig {
  /** Stick travel ignored around the centre, as a fraction of full deflection. */
  deadzone: number;
  /** Half view heights per second at full deflection. Proportional to the view,
   *  like the 3D mouse, so it feels the same zoomed in to a screw or out to a
   *  whole assembly. */
  panSens: number;
  /** Radians per second at full deflection. */
  orbitSens: number;
  /** ln(zoom factor) per second with one trigger fully in. */
  zoomSens: number;
  /** Screen pixels per second at full deflection, for the on-screen cursor. */
  cursorSpeed: number;
  invertOrbitX: boolean;
  invertOrbitY: boolean;
  /** Button index -> what it does. */
  buttons: Record<number, Binding>;
}

export const DEFAULTS: GamepadConfig = {
  deadzone: 0.15,
  panSens: 1.2,
  orbitSens: 2.4,
  zoomSens: 1.6,
  cursorSpeed: 900,
  invertOrbitX: false,
  invertOrbitY: false,
  buttons: {
    0: "key:Enter",
    1: "key:Escape",
    2: "undo",
    3: "key:Ctrl+K",
    4: CURSOR,
    5: "redo",
    8: "reset-camera",
    9: "save",
    10: "persp",
    11: "fit",
    12: "top",
    13: "front",
    14: "iso",
    15: "right",
  },
};

const KEY = "fundacad.gamepad.config";

function clamp(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
}

/** A stored config, repaired field by field. A hand-edited or older value can
 *  never leave a button without a binding or a sensitivity at NaN. */
export function parseConfig(raw: string | null): GamepadConfig {
  const cfg: GamepadConfig = structuredClone(DEFAULTS);
  if (!raw) return cfg;
  let saved: Partial<GamepadConfig>;
  try {
    saved = JSON.parse(raw) as Partial<GamepadConfig>;
  } catch {
    return cfg;
  }
  if (!saved || typeof saved !== "object") return cfg;
  cfg.deadzone = clamp(saved.deadzone, 0, 0.9, DEFAULTS.deadzone);
  cfg.panSens = clamp(saved.panSens, 0, 20, DEFAULTS.panSens);
  cfg.orbitSens = clamp(saved.orbitSens, 0, 20, DEFAULTS.orbitSens);
  cfg.zoomSens = clamp(saved.zoomSens, 0, 20, DEFAULTS.zoomSens);
  cfg.cursorSpeed = clamp(saved.cursorSpeed, 50, 5000, DEFAULTS.cursorSpeed);
  cfg.invertOrbitX = !!saved.invertOrbitX;
  cfg.invertOrbitY = !!saved.invertOrbitY;
  if (saved.buttons && typeof saved.buttons === "object") {
    for (const i of BINDABLE) {
      const b = (saved.buttons as Record<string, unknown>)[String(i)];
      if (typeof b === "string") cfg.buttons[i] = b;
    }
  }
  return cfg;
}

const CONFIG: GamepadConfig = parseConfig(safeRead());

function safeRead(): string | null {
  try {
    return readSetting(KEY);
  } catch {
    return null;
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(CONFIG));
  } catch {
    /* no storage, the change still holds for this session */
  }
}

export function getGamepadConfig(): GamepadConfig {
  return CONFIG;
}

/** Merge a patch into the live config and persist. `buttons` merges per button,
 *  so setting one binding never clears the others. */
export function setGamepadConfig(patch: Partial<GamepadConfig>) {
  const { buttons, ...rest } = patch;
  Object.assign(CONFIG, rest);
  if (buttons) Object.assign(CONFIG.buttons, buttons);
  persist();
}

export function resetGamepadConfig() {
  Object.assign(CONFIG, structuredClone(DEFAULTS));
  persist();
}

/** A stick with a radial deadzone, rescaled so motion starts at zero just past
 *  it instead of jumping to the deadzone's value. Radial rather than per axis,
 *  so a diagonal is not pulled onto the nearest straight line. */
export function stick(x: number, y: number, deadzone: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag <= deadzone || mag === 0) return [0, 0];
  const scaled = Math.min(1, (mag - deadzone) / (1 - deadzone));
  // squared response: fine control near the centre, full speed at the edge
  const k = (scaled * scaled) / mag;
  return [x * k, y * k];
}

/** What one frame asks of the camera, per second. */
export interface Motion {
  panX: number;
  panY: number;
  orbitAz: number;
  orbitPol: number;
  zoom: number;
  cursorX: number;
  cursorY: number;
}

/** One frame of pad state as camera and cursor velocities.
 *
 *  With the cursor on, the left stick moves the cursor instead of panning; the
 *  right stick and the triggers keep driving the camera either way, so a face
 *  can be lined up and clicked without leaving cursor mode. */
export function motionOf(
  axes: readonly number[],
  triggers: [number, number],
  cfg: GamepadConfig,
  cursorOn: boolean,
): Motion {
  const [lx, ly] = stick(axes[0] ?? 0, axes[1] ?? 0, cfg.deadzone);
  const [rx, ry] = stick(axes[2] ?? 0, axes[3] ?? 0, cfg.deadzone);
  const zoomIn = (triggers[1] > cfg.deadzone ? triggers[1] : 0) - (triggers[0] > cfg.deadzone ? triggers[0] : 0);
  return {
    panX: cursorOn ? 0 : lx * cfg.panSens,
    panY: cursorOn ? 0 : ly * cfg.panSens,
    cursorX: cursorOn ? lx * cfg.cursorSpeed : 0,
    cursorY: cursorOn ? ly * cfg.cursorSpeed : 0,
    orbitAz: (cfg.invertOrbitX ? 1 : -1) * rx * cfg.orbitSens,
    orbitPol: (cfg.invertOrbitY ? -1 : 1) * ry * cfg.orbitSens,
    zoom: zoomIn * cfg.zoomSens,
  };
}

/** The buttons that went down this frame and were up the last. Rising edges
 *  only, so holding a button runs its command once. */
export function pressed(prev: readonly boolean[], now: readonly boolean[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < now.length; i++) if (now[i] && !prev[i]) out.push(i);
  return out;
}

/** "key:Ctrl+K" -> { key: "k", ctrl: true }. Null for anything not a key. */
export function parseKey(b: Binding): { key: string; ctrl: boolean; shift: boolean } | null {
  if (!b.startsWith("key:")) return null;
  const parts = b.slice(4).split("+");
  const key = parts.pop() ?? "";
  if (!key) return null;
  return {
    key: key.length === 1 ? key.toLowerCase() : key,
    ctrl: parts.includes("Ctrl"),
    shift: parts.includes("Shift"),
  };
}
