// Every setting of the Accessibility section, stored per key, with the OS preference as the default where the OS
// has one. Plain TS so stores, tools and the announcer read it without Vue.

import { DEFAULT_DWELL_MS, setHoverDwellMs } from "./interactionPrefs";
import { readSetting } from "./storedSetting";

export type Animations = "system" | "on" | "off";
export type Verbosity = "off" | "errors" | "normal" | "verbose";
/** "system" is More when the OS asks for contrast, else Standard; contrastSetting.ts resolves and applies it. */
export type Contrast = "system" | "standard" | "more" | "maximum";

// The size settings, one block spread into the shared tables below.
/** The browser's zoom steps, in percent. */
export const INTERFACE_SIZES: readonly number[] = [80, 90, 100, 110, 125, 150, 175, 200];
export const INTERFACE_SIZE_MAX = 200;
export type ViewportLabels = "s" | "m" | "l" | "xl";
export const VIEWPORT_LABELS: readonly ViewportLabels[] = ["s", "m", "l", "xl"];

export interface SizePrefs {
  /** The zoom of the whole interface in percent, one of INTERFACE_SIZES. */
  interfaceSize: number;
  /** Line height 1.5, letter spacing 0.12em and word spacing 0.16em on all text, the WCAG text spacing test. */
  comfortableText: boolean;
  /** The size of the names drawn over the model: sketch dimensions and glyphs, plane names and the view cube. */
  viewportLabels: ViewportLabels;
}

const SIZE_DEFAULTS: SizePrefs = { interfaceSize: 100, comfortableText: false, viewportLabels: "m" };
const SIZE_KEYS: Record<keyof SizePrefs, string> = {
  interfaceSize: "fundacad.a11y.interfaceSize",
  comfortableText: "fundacad.a11y.comfortableText",
  viewportLabels: "fundacad.a11y.viewportLabels",
};

export function asInterfaceSize(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && INTERFACE_SIZES.includes(n) ? n : null;
}

export function asComfortableText(v: unknown): boolean | null {
  if (v === true || v === "true") return true;
  return v === false || v === "false" ? false : null;
}

export function asViewportLabels(v: unknown): ViewportLabels | null {
  return VIEWPORT_LABELS.includes(v as ViewportLabels) ? (v as ViewportLabels) : null;
}

const SIZE_GATES: { [K in keyof SizePrefs]: (v: unknown) => SizePrefs[K] | null } = {
  interfaceSize: asInterfaceSize,
  comfortableText: asComfortableText,
  viewportLabels: asViewportLabels,
};

export interface A11yPrefs extends SizePrefs {
  animations: Animations;
  /** How much the announcer speaks: nothing, errors only, prompts and results, or every change too. */
  verbosity: Verbosity;
  /** Letter, digit and symbol shortcuts without Ctrl or Cmd (WCAG 2.1.4). Voice control dictation and screen
   *  reader browse mode type those keys, so they can be turned off; chords, F keys and arrows stay. */
  singleKeys: boolean;
  contrast: Contrast;
  /** Opaque cards and pills instead of glass, so no model colour shows through; More and Maximum contrast imply it. */
  solidPanels: boolean;
  /** Larger click targets: every hit area grows from 24 to about 32 px, see targets.ts. */
  targets: Targets;
}

export const DEFAULT_A11Y: Readonly<A11yPrefs> = {
  animations: "system",
  verbosity: "normal",
  singleKeys: true,
  contrast: "system",
  solidPanels: false,
  targets: "default",
  ...SIZE_DEFAULTS,
};

/** One click for screen reader users. Later settings join it: Notification time Until dismissed. */
export const SCREEN_READER_PRESET: Readonly<Partial<A11yPrefs>> = {
  verbosity: "verbose",
  singleKeys: false,
  solidPanels: true,
};

// fundacad.animations predates this module and held "on" or "off", absent meaning follow the OS; both still read.
const KEYS: Record<keyof A11yPrefs, string> = {
  animations: "fundacad.animations",
  verbosity: "fundacad.a11y.verbosity",
  singleKeys: "fundacad.a11y.singleKeys",
  contrast: "fundacad.a11y.contrast",
  solidPanels: "fundacad.a11y.solidPanels",
  targets: "fundacad.a11y.targets",
  ...SIZE_KEYS,
};

const ANIMATIONS: readonly Animations[] = ["system", "on", "off"];
const VERBOSITY: readonly Verbosity[] = ["off", "errors", "normal", "verbose"];
const CONTRAST: readonly Contrast[] = ["system", "standard", "more", "maximum"];

export function asAnimations(v: unknown): Animations | null {
  return ANIMATIONS.includes(v as Animations) ? (v as Animations) : null;
}
export function asVerbosity(v: unknown): Verbosity | null {
  return VERBOSITY.includes(v as Verbosity) ? (v as Verbosity) : null;
}
/** A boolean setting is stored as "on" or "off". */
export function asOnOff(v: unknown): boolean | null {
  if (v === true || v === "on") return true;
  if (v === false || v === "off") return false;
  return null;
}
export function asContrast(v: unknown): Contrast | null {
  return CONTRAST.includes(v as Contrast) ? (v as Contrast) : null;
}
export function asFlag(v: unknown): boolean | null {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return null;
}

export type Targets = "default" | "large";
const TARGETS: readonly Targets[] = ["default", "large"];
export function asTargets(v: unknown): Targets | null {
  return TARGETS.includes(v as Targets) ? (v as Targets) : null;
}

const GATES: { [K in keyof A11yPrefs]: (v: unknown) => A11yPrefs[K] | null } = {
  animations: asAnimations,
  verbosity: asVerbosity,
  singleKeys: asOnOff,
  contrast: asContrast,
  solidPanels: asFlag,
  targets: asTargets,
  ...SIZE_GATES,
};

function readStored(): A11yPrefs {
  const out = { ...DEFAULT_A11Y };
  for (const k of Object.keys(KEYS) as (keyof A11yPrefs)[]) {
    const v = GATES[k](readSetting(KEYS[k]));
    if (v !== null) (out as Record<keyof A11yPrefs, unknown>)[k] = v;
  }
  return out;
}

let current = readStored();
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

const REDUCE = "(prefers-reduced-motion: reduce)";
const reduceQuery: MediaQueryList | null = typeof matchMedia === "function" ? matchMedia(REDUCE) : null;
if (reduceQuery) {
  // WKWebView before Safari 14 (macOS 10.15) has only the older addListener on a MediaQueryList.
  if (typeof reduceQuery.addEventListener === "function") reduceQuery.addEventListener("change", notify);
  else reduceQuery.addListener?.(notify);
}

/** The OS reduce motion setting as the webview reports it now: Windows Animation effects, macOS Reduce motion,
 *  GNOME Reduce animation. */
export function systemReducesMotion(): boolean {
  return reduceQuery?.matches ?? false;
}

export function a11yPrefs(): Readonly<A11yPrefs> {
  return current;
}

/** The announcement level, read by the announcer before it speaks. */
export function getVerbosity(): Verbosity {
  return current.verbosity;
}

/** Read by resolveShortcut and the sketch tool letters on every key. */
export function singleKeysOn(): boolean {
  return current.singleKeys;
}

// singleKeys is stored as "on" or "off", solidPanels as "true" or "false".
function store(k: keyof A11yPrefs, v: A11yPrefs[keyof A11yPrefs] | null) {
  try {
    if (v === null) localStorage.removeItem(KEYS[k]);
    else localStorage.setItem(KEYS[k], typeof v === "boolean" && k === "singleKeys" ? (v ? "on" : "off") : String(v));
  } catch {
    /* ignore */
  }
}

export function setA11yPref<K extends keyof A11yPrefs>(key: K, value: A11yPrefs[K]) {
  const v = GATES[key](value);
  if (v === null || v === current[key]) return;
  current = { ...current, [key]: v };
  store(key, v);
  notify();
}

export function applyScreenReaderPreset() {
  const next = { ...current, ...SCREEN_READER_PRESET };
  for (const k of Object.keys(SCREEN_READER_PRESET) as (keyof A11yPrefs)[]) store(k, next[k]);
  current = next;
  notify();
}

/** Back to the defaults, the OS ones included: every stored choice of the section is dropped, Hover delay too. */
export function resetA11yPrefs() {
  for (const k of Object.keys(KEYS) as (keyof A11yPrefs)[]) store(k, null);
  current = { ...DEFAULT_A11Y };
  setHoverDwellMs(DEFAULT_DWELL_MS);
  notify();
}

/** Fires on a change made here and on an OS preference change while the app runs. */
export function onA11yPrefsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
