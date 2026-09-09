// How the viewport is lit and what it is drawn against.
//
// The house shape for a user setting (ui/theme.ts, icons.ts, units.ts,
// layoutPrefs.ts): module state, a validating gate over the untrusted stored
// value, one `fundacad.*` key read at load, and a listener set so the surfaces
// re-render. No Vue import, which is what keeps the headless suite able to reach
// it, and no Three import either, so this stays a statement of what the user
// asked for rather than a piece of the renderer.
//
// A MAP, per-field sanitised, for layoutPrefs' reason: a stored object with a
// garbage `background` must not cost the user their lighting.
//
// WHY THE ENVIRONMENT IS A SETTING AT ALL. A physically-based metal is almost
// entirely REFLECTION: with nothing around it to reflect, it renders near black,
// which is what a copper part looked like the first time materials were drawn.
// The fix is an environment to reflect, and it is a setting rather than an
// always-on because it costs a cubemap and a PMREM pass at start-up, and because
// a flat lit look is the right one for reading geometry, which is what CAD is
// mostly for.

import { readSetting } from "./storedSetting";

/** What the model reflects. "studio" is a neutral room, generated in the
 *  renderer, no asset and no network. "none" is the flat lit look. */
export type Environment = "studio" | "none";

/** What the model is drawn against. "theme" follows the app's palette, which is
 *  what it has always done; the rest are fixed grounds for looking at a part
 *  rather than at the app. */
export type Background = "theme" | "dark" | "grey" | "light";

export interface RenderPrefs {
  environment: Environment;
  background: Background;
  /** Overall light level, 0.4 to 2. Multiplies the lighting rig AND the
   *  environment together, so the two cannot drift apart into a model that is
   *  lit from one side and reflecting from the other at a different exposure. */
  brightness: number;
}

export const DEFAULT_RENDER: RenderPrefs = {
  // On by default, unlike most settings that cost something: a metal that
  // renders black is not a defensible default, and the whole material library
  // is unreadable without it.
  environment: "studio",
  background: "theme",
  brightness: 1,
};

export const MIN_BRIGHTNESS = 0.4;
export const MAX_BRIGHTNESS = 2;

const ENVIRONMENTS: Environment[] = ["studio", "none"];
const BACKGROUNDS: Background[] = ["theme", "dark", "grey", "light"];

/** The fixed grounds, as 0xRRGGBB. "theme" is absent on purpose: it is answered
 *  by the stylesheet, not by a number here. */
export const BACKGROUND_COLOR: Record<Exclude<Background, "theme">, number> = {
  dark: 0x0e1013,
  grey: 0x4a4f57,
  light: 0xd8dbe0,
};

const KEY = "fundacad.render";

export function asEnvironment(v: unknown): Environment | null {
  return ENVIRONMENTS.includes(v as Environment) ? (v as Environment) : null;
}

export function asBackground(v: unknown): Background | null {
  return BACKGROUNDS.includes(v as Background) ? (v as Background) : null;
}

/** Clamp a brightness into range, or null when it is not a number at all.
 *  Clamped rather than refused: a value out of range is a value somebody meant,
 *  and the nearest legal one is closer to it than the default is. */
export function asBrightness(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(MAX_BRIGHTNESS, Math.max(MIN_BRIGHTNESS, v));
}

/** Narrow untrusted JSON to a complete RenderPrefs, field by field. */
export function asRenderPrefs(v: unknown): RenderPrefs {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...DEFAULT_RENDER };
  const o = v as Record<string, unknown>;
  return {
    environment: asEnvironment(o["environment"]) ?? DEFAULT_RENDER.environment,
    background: asBackground(o["background"]) ?? DEFAULT_RENDER.background,
    brightness: asBrightness(o["brightness"]) ?? DEFAULT_RENDER.brightness,
  };
}

function readStored(): RenderPrefs {
  try {
    const raw = readSetting(KEY);
    return raw ? asRenderPrefs(JSON.parse(raw)) : { ...DEFAULT_RENDER };
  } catch {
    // Unparseable JSON is treated as no setting at all: the viewport opens
    // looking the way it does out of the box rather than failing to render.
    return { ...DEFAULT_RENDER };
  }
}

let current = readStored();
const listeners = new Set<() => void>();

/** Read-only. Go through setRenderPref so the write is persisted and the
 *  viewport is told. */
export function renderPrefs(): Readonly<RenderPrefs> {
  return current;
}

export function setRenderPref<K extends keyof RenderPrefs>(key: K, value: RenderPrefs[K]): void {
  const ok =
    key === "environment" ? asEnvironment(value)
      : key === "background" ? asBackground(value)
        : asBrightness(value);
  if (ok === null || current[key] === ok) return;
  // A fresh object rather than a mutation, so a subscriber may hold the result
  // of renderPrefs() and compare identity to decide it must redraw.
  current = { ...current, [key]: ok };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode / no storage: the choice just doesn't survive the session */
  }
  for (const fn of listeners) fn();
}

/** Subscribe to changes; returns the unsubscribe. */
export function onRenderPrefsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
