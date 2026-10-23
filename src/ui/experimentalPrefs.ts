// Limits the app keeps for stability, raisable from Preferences, Experimental. The defaults are the limits as they
// always were, so nothing changes for someone who never opens the tab.

import { readSetting } from "./storedSetting";

/** The width an imported panorama is kept at, or "gpu" for as large as the graphics card's textures go. */
export type EnvWidth = 2048 | 4096 | 8192 | 16384 | "gpu";
export const ENV_WIDTHS: readonly EnvWidth[] = [2048, 4096, 8192, 16384, "gpu"];

export interface ExperimentalPrefs {
  envWidth: EnvWidth;
  /** Samples per pixel where Path traced stops, on mains power and on battery. */
  sampleCap: number;
  batterySampleCap: number;
  /** How many times a path bounces, in both tracers. */
  bounces: number;
  /** The luminance an indirect contribution is clamped to in the native tracer, 0 for no clamp. */
  firefly: number;
  /** The viewport trace's resolution against the screen's pixels, 0 for the automatic choice. */
  traceScale: number;
  /** The most pixels a traced picture is taken at. */
  pictureMegapixels: number;
  /** The most triangles Path traced takes on. */
  triangleBudget: number;
}

export const DEFAULT_EXPERIMENTAL: Readonly<ExperimentalPrefs> = {
  envWidth: 2048,
  sampleCap: 256,
  batterySampleCap: 64,
  bounces: 6,
  firefly: 10,
  traceScale: 0,
  pictureMegapixels: (3840 * 2160) / 1e6,
  triangleBudget: 3_000_000,
};

/** The range each number may be raised or lowered to. */
export const EXPERIMENTAL_RANGE: Record<Exclude<keyof ExperimentalPrefs, "envWidth">, [number, number]> = {
  sampleCap: [1, 65536],
  batterySampleCap: [1, 65536],
  bounces: [1, 64],
  firefly: [0, 1e6],
  traceScale: [0, 2],
  pictureMegapixels: [0.1, 268],
  triangleBudget: [1000, 500_000_000],
};

const KEY = "fundacad.experimental";

function asNumber(v: unknown, [lo, hi]: [number, number]): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, v));
}

export function asEnvWidth(v: unknown): EnvWidth | null {
  return ENV_WIDTHS.includes(v as EnvWidth) ? (v as EnvWidth) : null;
}

/** Untrusted JSON narrowed field by field, a missing or garbage field left at its default. */
export function asExperimentalPrefs(v: unknown): ExperimentalPrefs {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: ExperimentalPrefs = { ...DEFAULT_EXPERIMENTAL };
  out.envWidth = asEnvWidth(o["envWidth"]) ?? out.envWidth;
  for (const k of Object.keys(EXPERIMENTAL_RANGE) as (keyof typeof EXPERIMENTAL_RANGE)[]) {
    const n = asNumber(o[k], EXPERIMENTAL_RANGE[k]);
    if (n !== null) out[k] = k === "bounces" || k === "sampleCap" || k === "batterySampleCap" ? Math.round(n) : n;
  }
  return out;
}

function readStored(): ExperimentalPrefs {
  try {
    const raw = readSetting(KEY);
    return raw ? asExperimentalPrefs(JSON.parse(raw)) : { ...DEFAULT_EXPERIMENTAL };
  } catch {
    return { ...DEFAULT_EXPERIMENTAL };
  }
}

let current = readStored();
const listeners = new Set<() => void>();

export function experimentalPrefs(): Readonly<ExperimentalPrefs> {
  return current;
}

function write(next: ExperimentalPrefs) {
  current = next;
  try {
    const changed = Object.fromEntries(
      Object.entries(next).filter(([k, v]) => DEFAULT_EXPERIMENTAL[k as keyof ExperimentalPrefs] !== v),
    );
    if (Object.keys(changed).length) localStorage.setItem(KEY, JSON.stringify(changed));
    else localStorage.removeItem(KEY);
  } catch {
    /* no storage: the change lasts the session */
  }
  for (const fn of listeners) fn();
}

export function setExperimentalPref<K extends keyof ExperimentalPrefs>(key: K, value: ExperimentalPrefs[K]): void {
  const next = asExperimentalPrefs({ ...current, [key]: value });
  if (next[key] === current[key]) return;
  write(next);
}

export function resetExperimentalPrefs(): void {
  write({ ...DEFAULT_EXPERIMENTAL });
}

export function onExperimentalPrefsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The width an imported panorama is kept at, `gpuMax` standing in for "gpu" and capping the rest. */
export function storedEnvWidth(p: Readonly<ExperimentalPrefs>, gpuMax: number): number {
  const w = p.envWidth === "gpu" ? gpuMax : p.envWidth;
  return Math.max(2, Math.min(w, gpuMax));
}

/** The width the Realtime lighting reads, half the stored one as it always was. */
export function lightingEnvWidth(p: Readonly<ExperimentalPrefs>, gpuMax: number): number {
  return Math.max(2, Math.floor(storedEnvWidth(p, gpuMax) / 2));
}
