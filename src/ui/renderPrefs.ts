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

/** What the model reflects, and therefore most of what a metal LOOKS like.
 *
 *  Every one of these is GENERATED, in the renderer, from a handful of emissive
 *  boxes: no HDR file, no asset in the bundle, no network at start-up. That is
 *  the constraint the list is designed around and the reason the entries are
 *  moods rather than places. A photograph of a real room would be a megabyte
 *  fetched to make a chamfer shine; a soft box above and slightly to the left is
 *  four rectangles, and it is what a product photograph is actually lit with.
 *
 *  "none" is the flat lit look, which is still the right one for reading
 *  geometry: reflections are information about the surface, and while you are
 *  looking for a misplaced hole they are noise over the thing you are reading. */
export type Environment = "studio" | "softbox" | "warm" | "dusk" | "bright" | "none";

/** The list, in the order it is offered, with what each is FOR. The note is
 *  shown under the name: a row of six unlabelled greys is a row nobody can
 *  choose from without trying all six.
 *
 *  `swatch` is a CSS gradient standing in for the room, not a render of it.
 *  Rendering six previews means generating six cubemaps, which is six PMREM
 *  passes to open a settings tab, and the thing a swatch has to communicate here
 *  is a MOOD, where the light comes from and what colour it is. A gradient does
 *  that in twenty bytes. It is a compile-time constant like everything else that
 *  reaches the DOM as markup. */
export const ENVIRONMENTS_LIST: readonly {
  id: Environment; label: string; note: string; swatch: string;
}[] = [
  {
    id: "studio", label: "Studio", note: "Neutral room, even light",
    swatch: "radial-gradient(circle at 35% 28%, #f4f6f8 0%, #9aa3ad 45%, #3d4249 100%)",
  },
  {
    id: "softbox", label: "Soft box", note: "One big light, product shot",
    swatch: "radial-gradient(circle at 28% 22%, #ffffff 0%, #7d858e 38%, #14171b 100%)",
  },
  {
    id: "warm", label: "Warm key", note: "Warm light, cool shade",
    swatch: "radial-gradient(circle at 68% 26%, #ffd9a0 0%, #b98a55 42%, #2b3550 100%)",
  },
  {
    id: "dusk", label: "Dusk", note: "Dark, with a bright rim",
    swatch: "radial-gradient(circle at 50% 86%, #d8e8ff 0%, #2a3550 26%, #0a0c12 70%)",
  },
  {
    id: "bright", label: "Bright room", note: "High key, white walls",
    swatch: "radial-gradient(circle at 45% 30%, #ffffff 0%, #e6eaef 55%, #b9c0c8 100%)",
  },
  {
    id: "none", label: "Flat", note: "No reflections, easiest to read",
    swatch: "linear-gradient(160deg, #6a727b 0%, #4a5058 100%)",
  },
];

/** What the model is drawn against. "theme" follows the app's palette, which is
 *  what it has always done; the rest are fixed grounds for looking at a part
 *  rather than at the app. */
export type Background = "theme" | "dark" | "grey" | "light";

/** How much light spills off the bright parts of the image.
 *
 *  Tuned around a HIGH threshold rather than a low strength, which is what makes
 *  it safe to leave on: an ordinary matt part never gets bright enough to bloom
 *  at all, so the setting costs an unlit model nothing but a pass, and a lit
 *  indicator or a specular highlight on polished metal reads as light rather
 *  than as a pale patch. */
export type Bloom = "off" | "subtle" | "strong";

/** What each level asks the bloom pass for. `threshold` is the luminance a
 *  pixel has to reach before it spills at all, and it is the number that decides
 *  whether this is a look or a haze.
 *
 *  ABOVE 1 for subtle, deliberately, and that is the whole tuning. The pass runs
 *  on the LINEAR image before tone mapping, where an ordinary white part under a
 *  key light at intensity 2 sits well over 1 already: at 0.85 the white plastic
 *  test cylinder haloed as hard as the lit one and the whole viewport went pale.
 *  Only something actually emitting gets past 1.15, which is what makes "on by
 *  default" a defensible thing to do to somebody's matt grey part. */
export const BLOOM_SETTINGS: Record<Exclude<Bloom, "off">, {
  strength: number;
  radius: number;
  threshold: number;
}> = {
  subtle: { strength: 0.4, radius: 0.3, threshold: 2 },
  strong: { strength: 0.7, radius: 0.55, threshold: 0.9 },
};

/** What the material's 0..1 Glow slider means in the renderer.
 *
 *  Not 1:1. `emissiveIntensity` is a multiplier on a linear colour, so a slider
 *  that stopped at 1 could never push a mid-tone colour past the bloom threshold
 *  above and the top of the slider would do visibly nothing. At 2 the top of the
 *  slider is a part that unmistakably emits and the middle is one that is merely
 *  lit from within. */
export const MAX_EMISSIVE_INTENSITY = 4;

export interface RenderPrefs {
  environment: Environment;
  background: Background;
  /** Overall light level, 0.4 to 2. Multiplies the lighting rig AND the
   *  environment together, so the two cannot drift apart into a model that is
   *  lit from one side and reflecting from the other at a different exposure. */
  brightness: number;
  bloom: Bloom;
  /** The perspective lens, in degrees. 20 is a long lens that flattens a part
   *  and keeps its edges parallel, 65 is a wide one that throws the near corner
   *  at you. The orthographic views ignore it, having no lens at all. */
  fov: number;
  /** Depth of field, as an f-stop: 1.4 is a sliver of the part in focus and 22
   *  is effectively everything. Only does anything while `focusBlur` is above
   *  zero, exactly as a lens only shows its aperture when it is open. */
  aperture: number;
  /** How strong the out-of-focus blur is, 0 to 1. ZERO BY DEFAULT, and that is
   *  the switch: at zero the depth-of-field pass is not built and not drawn, so
   *  a viewport nobody has asked for a photograph from pays nothing at all.
   *
   *  A CAD viewport with permanent depth of field would be actively hostile,
   *  half the model soft while you are trying to pick an edge on it. This is for
   *  the picture at the end. */
  focusBlur: number;
}

/** What the f-stop numbers mean to the blur pass, and the range the control
 *  offers. Photographic values rather than 0..1 because everybody who has ever
 *  held a camera knows which way f/2 is from f/11, and nobody knows what 0.3 of
 *  an aperture is. */
export const APERTURE_STOPS: readonly number[] = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];
export const MIN_FOV = 15;
export const MAX_FOV = 70;

export const DEFAULT_RENDER: RenderPrefs = {
  // On by default, unlike most settings that cost something: a metal that
  // renders black is not a defensible default, and the whole material library
  // is unreadable without it.
  environment: "studio",
  background: "theme",
  brightness: 1,
  // On, gently. It costs a pass whether or not anything is bright enough to
  // use it, and it is what makes an emissive material read as a light instead
  // of as a flat bright patch, which is the only reason to have one.
  bloom: "subtle",
  // The lens the app has always had, now written down.
  fov: 45,
  aperture: 4,
  // OFF. See the field comment: this is the one render setting that would make
  // the app harder to model in, so it starts at zero and stays there until
  // somebody is deliberately taking a picture.
  focusBlur: 0,
};

export const MIN_BRIGHTNESS = 0.4;
export const MAX_BRIGHTNESS = 2;

const ENVIRONMENTS: Environment[] = ENVIRONMENTS_LIST.map((e) => e.id);
const BACKGROUNDS: Background[] = ["theme", "dark", "grey", "light"];
const BLOOMS: Bloom[] = ["off", "subtle", "strong"];

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

export function asBloom(v: unknown): Bloom | null {
  return BLOOMS.includes(v as Bloom) ? (v as Bloom) : null;
}

/** Clamp a number into range, or null when it is not one. The same bargain
 *  asBrightness strikes, and for the same reason: a value out of range is a
 *  value somebody meant. */
function asClamped(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, v));
}

export function asFov(v: unknown): number | null {
  return asClamped(v, MIN_FOV, MAX_FOV);
}

export function asAperture(v: unknown): number | null {
  return asClamped(v, 1.4, 22);
}

export function asFocusBlur(v: unknown): number | null {
  return asClamped(v, 0, 1);
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
    bloom: asBloom(o["bloom"]) ?? DEFAULT_RENDER.bloom,
    fov: asFov(o["fov"]) ?? DEFAULT_RENDER.fov,
    aperture: asAperture(o["aperture"]) ?? DEFAULT_RENDER.aperture,
    focusBlur: asFocusBlur(o["focusBlur"]) ?? DEFAULT_RENDER.focusBlur,
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
        : key === "bloom" ? asBloom(value)
          : key === "fov" ? asFov(value)
            : key === "aperture" ? asAperture(value)
              : key === "focusBlur" ? asFocusBlur(value)
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
