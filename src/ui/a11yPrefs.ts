// Every setting of the Accessibility section, stored per key, with the OS preference as the default where the OS
// has one. Plain TS so stores, tools and the announcer read it without Vue.

import { DEFAULT_DWELL_MS, setHoverDwellMs } from "./interactionPrefs";
import { readSetting } from "./storedSetting";

export type Animations = "system" | "on" | "off";
export type Verbosity = "off" | "errors" | "normal" | "verbose";

// The size settings, one block spread into the shared tables below.
/** The browser's zoom steps, in percent. */
export const INTERFACE_SIZES: readonly number[] = [80, 90, 100, 110, 125, 150, 175, 200];
/** Held at 150 until every control stays reachable at 200. */
export const INTERFACE_SIZE_MAX = 150;

export interface SizePrefs {
  /** The zoom of the whole interface in percent, one of INTERFACE_SIZES up to INTERFACE_SIZE_MAX. */
  interfaceSize: number;
}

const SIZE_DEFAULTS: SizePrefs = { interfaceSize: 100 };
const SIZE_KEYS: Record<keyof SizePrefs, string> = { interfaceSize: "fundacad.a11y.interfaceSize" };

/** A size stored by a build with a higher cap reads back as the cap. */
export function asInterfaceSize(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !INTERFACE_SIZES.includes(n)) return null;
  return Math.min(n, INTERFACE_SIZE_MAX);
}

const SIZE_GATES: { [K in keyof SizePrefs]: (v: unknown) => SizePrefs[K] | null } = {
  interfaceSize: asInterfaceSize,
};

export interface A11yPrefs extends SizePrefs {
  animations: Animations;
  /** How much the announcer speaks: nothing, errors only, prompts and results, or every change too. */
  verbosity: Verbosity;
}

export const DEFAULT_A11Y: Readonly<A11yPrefs> = { animations: "system", verbosity: "normal", ...SIZE_DEFAULTS };

/** One click for screen reader users. Later settings join it: Single key shortcuts off, Solid panels on and
 *  Notification time Until dismissed. */
export const SCREEN_READER_PRESET: Readonly<Partial<A11yPrefs>> = { verbosity: "verbose" };

// fundacad.animations predates this module and held "on" or "off", absent meaning follow the OS; both still read.
const KEYS: Record<keyof A11yPrefs, string> = {
  animations: "fundacad.animations",
  verbosity: "fundacad.a11y.verbosity",
  ...SIZE_KEYS,
};

const ANIMATIONS: readonly Animations[] = ["system", "on", "off"];
const VERBOSITY: readonly Verbosity[] = ["off", "errors", "normal", "verbose"];

export function asAnimations(v: unknown): Animations | null {
  return ANIMATIONS.includes(v as Animations) ? (v as Animations) : null;
}
export function asVerbosity(v: unknown): Verbosity | null {
  return VERBOSITY.includes(v as Verbosity) ? (v as Verbosity) : null;
}

const GATES: { [K in keyof A11yPrefs]: (v: unknown) => A11yPrefs[K] | null } = {
  animations: asAnimations,
  verbosity: asVerbosity,
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

function store(k: keyof A11yPrefs, v: A11yPrefs[keyof A11yPrefs] | null) {
  try {
    if (v === null) localStorage.removeItem(KEYS[k]);
    else localStorage.setItem(KEYS[k], String(v));
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
