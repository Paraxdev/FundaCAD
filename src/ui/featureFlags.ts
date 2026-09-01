// Capabilities the app can be built with and shipped without.
//
// Not preferences. A preference is a choice between two ways of doing the same
// thing, and both are worth having; a flag here is a whole feature that only
// earns its place on a machine that can use it. Off, the feature is not merely
// hidden from a menu — every surface it owns is absent, so it costs the user no
// attention at all.
//
// The house shape for a user setting (ui/theme.ts, icons.ts, units.ts,
// layoutPrefs.ts): module state, a validating gate over the untrusted stored
// value, one `fundacad.*` key read at load, and a listener set so live surfaces
// re-render. No Vue import — that is what keeps the headless *.test.ts suite
// able to reach it.
//
// A MAP rather than one value, like layoutPrefs, so it sanitises PER FIELD: a
// second flag added later must not be able to cost the user the first.
//
// WHAT A FLAG MAY NOT DO: touch the document. Turning `multiColor` off hides
// the palette, the per-body slot assignments and the paint they produce, but it
// does not delete any of them — they are saved, loaded and exported exactly as
// before, so turning it back on finds the work still there. A toggle that ate
// data would not be a toggle.

import { readSetting } from "./storedSetting";

export interface FeatureFlags {
  /** Assigning bodies and texture inlays to filament slots, the browser's
   *  palette, the paint that assignment puts in the viewport, and the toolhead
   *  mapping a multi-material print asks for.
   *
   *  Off by default because all of it answers to hardware. A palette is "the
   *  material loaded in toolhead N" and the mapping dialog is a question about a
   *  machine; on a single-material printer every one of those surfaces is a
   *  control with nothing on the other end. */
  multiColor: boolean;
}

/** Everything off. A flag defaults on only once it stops being optional. */
export const DEFAULT_FLAGS: FeatureFlags = { multiColor: false };

const KEY = "fundacad.features";
const LEGACY_KEYS = ["neocad.features", "sindricad.features"];

/** Narrow untrusted JSON to a complete FeatureFlags, field by field. */
export function asFeatureFlags(v: unknown): FeatureFlags {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...DEFAULT_FLAGS };
  const o = v as Record<string, unknown>;
  return {
    multiColor: typeof o["multiColor"] === "boolean" ? o["multiColor"] : DEFAULT_FLAGS.multiColor,
  };
}

function readStored(): FeatureFlags {
  try {
    const raw = readSetting(KEY, ...LEGACY_KEYS);
    return raw ? asFeatureFlags(JSON.parse(raw)) : { ...DEFAULT_FLAGS };
  } catch {
    // Unparseable JSON is treated as no setting at all. Failing closed is the
    // right way round here: the default is off, so a corrupt value costs the
    // user a checkbox rather than turning something on behind their back.
    return { ...DEFAULT_FLAGS };
  }
}

let current = readStored();
const listeners = new Set<() => void>();

/** Read-only — go through setFeatureFlag so the write is persisted and
 *  subscribers are told. */
export function featureFlags(): Readonly<FeatureFlags> {
  return current;
}

/** The one flag most call sites want, spelled so a reader does not have to know
 *  there is a map behind it. */
export function multiColorEnabled(): boolean {
  return current.multiColor;
}

export function setFeatureFlag<K extends keyof FeatureFlags>(key: K, value: FeatureFlags[K]): void {
  if (typeof value !== "boolean" || current[key] === value) return;
  // A fresh object rather than a mutation, so a subscriber may hold the result
  // of featureFlags() and compare identity to decide it must redraw.
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode / no storage: the choice just doesn't survive the session */
  }
  for (const fn of listeners) fn();
}

/** Subscribe to changes; returns the unsubscribe. */
export function onFeatureFlagsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
