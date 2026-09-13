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
