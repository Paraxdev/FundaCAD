// How long the cursor has to stay on a body before its faces, rather than the
// whole body, are what a click takes. Persisted per browser like the unit.

import { readSetting } from "./storedSetting";

const KEY = "fundacad.hoverDwellMs";
export const DEFAULT_DWELL_MS = 800;
export const MIN_DWELL_MS = 200;
export const MAX_DWELL_MS = 2000;

let current = readStored();
const listeners = new Set<() => void>();

export function asDwellMs(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(MAX_DWELL_MS, Math.max(MIN_DWELL_MS, n)));
}

function readStored(): number {
  return asDwellMs(readSetting(KEY)) ?? DEFAULT_DWELL_MS;
}

export function getHoverDwellMs(): number {
  return current;
}

export function setHoverDwellMs(ms: number) {
  const v = asDwellMs(ms);
  if (v === null || v === current) return;
  current = v;
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn();
}

export function onHoverDwellChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// --- navigation ----------------------------------------------------------------

/** Which camera rig the viewport runs: the navigator (the default), or the camera-controls
 *  one kept for a release behind `?nav=legacy` or this setting. */
export type NavigatorChoice = "v2" | "legacy";
const NAV_KEY = "fundacad.navigator";
const DEFAULT_NAVIGATOR: NavigatorChoice = "v2";

export function navigatorChoice(): NavigatorChoice {
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("nav") : null;
  if (q === "v2" || q === "legacy") return q;
  const s = readSetting(NAV_KEY);
  if (s === "v2" || s === "legacy") return s;
  return DEFAULT_NAVIGATOR;
}

/** Stored for the next start: the rig is chosen once, when the viewport is made. */
export function setNavigatorChoice(choice: NavigatorChoice) {
  try {
    localStorage.setItem(NAV_KEY, choice);
  } catch {
    /* ignore */
  }
}

export interface NavPrefs {
  /** An orbit keeps turning a moment after release, about the same pivot. */
  inertia: boolean;
  /** A plain wheel (two-finger scroll) pans; ctrl+wheel and pinch still zoom. */
  scrollPans: boolean;
  /** Smooth time of eased zooms and drags, seconds. */
  smoothTime: number;
}

const NAV_PREFS_KEY = "fundacad.navigation";
const NAV_DEFAULTS: NavPrefs = { inertia: false, scrollPans: false, smoothTime: 0.125 };

function readNavPrefs(): NavPrefs {
  try {
    const raw = readSetting(NAV_PREFS_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<NavPrefs>) : {};
    const t = typeof v.smoothTime === "number" && Number.isFinite(v.smoothTime) ? v.smoothTime : NAV_DEFAULTS.smoothTime;
    return {
      inertia: typeof v.inertia === "boolean" ? v.inertia : NAV_DEFAULTS.inertia,
      scrollPans: typeof v.scrollPans === "boolean" ? v.scrollPans : NAV_DEFAULTS.scrollPans,
      smoothTime: Math.min(0.5, Math.max(0, t)),
    };
  } catch {
    return { ...NAV_DEFAULTS };
  }
}

let navPrefs = readNavPrefs();
const navListeners = new Set<() => void>();

export function getNavPrefs(): NavPrefs {
  return navPrefs;
}

export function setNavPrefs(patch: Partial<NavPrefs>) {
  navPrefs = { ...navPrefs, ...patch };
  try {
    localStorage.setItem(NAV_PREFS_KEY, JSON.stringify(navPrefs));
  } catch {
    /* ignore */
  }
  for (const fn of navListeners) fn();
}

export function onNavPrefsChange(fn: () => void): () => void {
  navListeners.add(fn);
  return () => navListeners.delete(fn);
}

// --- datum plane handles -------------------------------------------------------

/** How a datum plane is tilted and turned: its own arcs while creating and on
 *  edit ("arcs"), or the Move gizmo on the selected plane ("move"). */
export type PlaneGizmoChoice = "arcs" | "move";
const PLANE_GIZMO_KEY = "fundacad.planeGizmo";

export function planeGizmoChoice(): PlaneGizmoChoice {
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("planeGizmo") : null;
  if (q === "arcs" || q === "move") return q;
  const s = readSetting(PLANE_GIZMO_KEY);
  if (s === "arcs" || s === "move") return s;
  return "arcs";
}
