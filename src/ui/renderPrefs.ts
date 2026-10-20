// How the viewport is lit and what it is drawn against.
//
// The house shape for a user setting (ui/theme.ts, icons.ts, units.ts):
// module state, a validating gate over the untrusted stored
// value, one `fundacad.*` key read at load, and a listener set so the surfaces
// re-render. No Vue import, which is what keeps the headless suite able to reach
// it, and no Three import either, so this stays a statement of what the user
// asked for rather than a piece of the renderer.
//
// A MAP, sanitised per field: a stored object with a garbage `background` must
// not cost the user their lighting.
//
// WHY THE ENVIRONMENT IS A SETTING AT ALL. A physically-based metal is almost
// entirely REFLECTION: with nothing around it to reflect, it renders near black,
// which is what a copper part looked like the first time materials were drawn.
// The fix is an environment to reflect, and it is a setting rather than an
// always-on because it costs a cubemap and a PMREM pass at start-up, and because
// a flat lit look is the right one for reading geometry, which is what CAD is
// mostly for.

import { readSetting } from "./storedSetting";
import { DEFAULT_KEY } from "../viewport/keyLight";
import { DEFAULT_OVERLAYS, asOverlays, type OverlayState } from "../viewport/overlayKinds";

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

/** An imported panorama, by the SHA-256 of its stored pixels
 *  (ui/environmentLibrary.ts keeps them, viewport/hdrRegistry.ts holds them in memory). */
export type HdrEnvironment = `hdr:${string}`;
export type EnvironmentChoice = Environment | HdrEnvironment;

export function isHdrEnvironment(v: unknown): v is HdrEnvironment {
  return typeof v === "string" && /^hdr:[0-9a-f]{16,64}$/.test(v);
}

export function hdrHashOf(env: EnvironmentChoice): string | null {
  return isHdrEnvironment(env) ? env.slice(4) : null;
}

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
/** Bloom amount, 0 (off) to 1 (full). A continuous slider rather than named
 *  levels: "subtle" and "strong" were only two points on this line. */
export type Bloom = number;

export const DEFAULT_BLOOM = 0.4;

/** What a given bloom AMOUNT asks the pass for. `threshold` is the luminance a
 *  pixel has to reach before it spills at all, and it is the number that decides
 *  whether this is a look or a haze.
 *
 *  Threshold runs HIGH to LOW as the slider rises, and that is the whole tuning.
 *  The pass runs on the LINEAR image before tone mapping, where an ordinary white
 *  part under a key light at intensity 2 sits well over 1 already: at 0.85 the
 *  white plastic test cylinder haloed as hard as the lit one and the viewport
 *  went pale. So the lower half of the slider keeps the threshold ABOVE 1, where
 *  only something actually emitting spills, and only the top of the slider reaches
 *  an ordinary highlight. That is what makes leaving it on by default defensible. */
export function bloomSettings(amount: number): { strength: number; radius: number; threshold: number } {
  const a = Math.min(1, Math.max(0, amount));
  // Squared since three r186: its UnrealBloomPass glow grows linearly with strength,
  // r180's grew with its square, and 0.7 * a^2 matched r180 at every slider position.
  return { strength: 0.7 * a * a, radius: 0.3 + a * 0.3, threshold: 2.0 - a * 1.2 };
}

/** A threshold above 1 only lets through what is brighter than a fully lit white
 *  surface, so with nothing glowing or shiny on screen the whole pass would draw
 *  the image unchanged. */
export function bloomWanted(amount: number, bloomable: boolean): boolean {
  if (!(amount > 0)) return false;
  return bloomable || bloomSettings(amount).threshold < 1;
}

/** What the material's 0..1 Emission slider means in the renderer.
 *
 *  Not 1:1. `emissiveIntensity` is a multiplier on a linear colour, so a slider
 *  that stopped at 1 could never push a mid-tone colour past the bloom threshold
 *  above and the top of the slider would do visibly nothing. At 2 the top of the
 *  slider is a part that unmistakably emits and the middle is one that is merely
 *  lit from within. */
export const MAX_EMISSIVE_INTENSITY = 4;

/** How an edge where two faces meet tangentially is drawn: a fillet's
 *  boundaries, and a corner patch's, which run across what looks like one
 *  continuous surface. */
export type TangentEdges = "show" | "faint" | "hide";

/** How the viewport shades the model (ui/viewMode.ts). */
export type ViewMode = "matcap" | "realtime" | "pathtraced";

/** The sphere Matcap shades with (viewport/matcap.ts draws each one). */
export const MATCAP_STYLES = ["studio", "clay", "metal", "wax"] as const;
export type MatcapStyle = (typeof MATCAP_STYLES)[number];

/** How Path traced cleans its noise: off, the small denoise weights, or the large ones. */
export const DENOISE_LEVELS = ["off", "standard", "high"] as const;
export type Denoise = (typeof DENOISE_LEVELS)[number];

/** Which tracer Path traced runs on (viewport/pathtrace/choose.ts). */
export const TRACER_PREFS = ["auto", "native", "webgpu"] as const;
export type TracerPref = (typeof TRACER_PREFS)[number];

/** What the model stands on: nothing, or a catcher plane with a soft contact
 *  shadow (viewport/contactShadow.ts). */
export const GROUNDS = ["none", "shadow"] as const;
export type Ground = (typeof GROUNDS)[number];

export interface RenderPrefs {
  environment: EnvironmentChoice;
  /** An imported panorama's turn about the up axis, degrees, and its exposure
   *  in stops. Built in rooms ignore both. */
  envRotation: number;
  envExposure: number;
  /** Draw the imported panorama behind the model instead of the ground colour. */
  envBackground: boolean;
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
  /** Force the lightweight render even on a machine the auto-detect thinks is
   *  capable: glass falls back to flat alpha (no transmission pass), the pixel
   *  ratio is capped low, and fewer emitter lights are drawn. For an older
   *  dedicated GPU that reports a real name (so `detectLowPower` passes it) but
   *  still stutters on the heavy effects, this is the manual escape hatch. */
  performanceMode: boolean;
  /** The lowest render, for software rendering in a virtual machine. Implies
   *  performance mode without writing it, so turning this off leaves
   *  performanceMode as the user last set it. */
  potatoMode: boolean;
  /** Ground the model with real cast shadows from the key light, not just the
   *  soft occlusion an emissive part throws. OFF by default: a shadow under every
   *  part is a look, and the app has always drawn a clean, shadowless product
   *  view, so this is opt-in. Ignored on the lightweight tier (no shadow map). */
  shadows: boolean;
  /** Drawn like every other edge, lighter, or not at all. FAINT by default: a
   *  near-sharp profiled corner's patch borders ran across its flat top and
   *  read as a curve that was not there. */
  tangentEdges: TangentEdges;
  /** Where the key light shines from, degrees round the up axis from +X and
   *  above the ground (viewport/keyLight.ts). Aimed on the canvas in Render. */
  keyAzimuth: number;
  keyElevation: number;
  /** The view mode last chosen in each workspace. */
  viewModeModel: ViewMode;
  viewModeRender: ViewMode;
  /** The overlays drawn in each workspace (viewport/overlayKinds.ts). */
  overlaysModel: OverlayState;
  overlaysRender: OverlayState;
  /** The ground chosen in each workspace. NONE in both by default, for the
   *  reason `shadows` is off: a shadow under every part is a look. */
  groundModel: Ground;
  groundRender: Ground;
  /** Matcap's sphere, and whether it keeps body colours (false is plain). */
  matcapStyle: MatcapStyle;
  matcapTint: boolean;
  denoise: Denoise;
  tracer: TracerPref;
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
  envRotation: 0,
  envExposure: 0,
  envBackground: false,
  background: "theme",
  brightness: 1,
  // On, gently. It costs a pass whether or not anything is bright enough to
  // use it, and it is what makes an emissive material read as a light instead
  // of as a flat bright patch, which is the only reason to have one.
  bloom: DEFAULT_BLOOM,
  // The lens the app has always had, now written down.
  fov: 45,
  aperture: 4,
  // OFF. See the field comment: this is the one render setting that would make
  // the app harder to model in, so it starts at zero and stays there until
  // somebody is deliberately taking a picture.
  focusBlur: 0,
  // OFF: the auto-detect already spares the machines that genuinely cannot cope,
  // so this stays off until someone whose GPU slipped past it turns it on.
  performanceMode: false,
  potatoMode: false,
  // OFF: opt-in grounded shadows, see the field comment.
  shadows: false,
  tangentEdges: "faint",
  keyAzimuth: DEFAULT_KEY.azimuth,
  keyElevation: DEFAULT_KEY.elevation,
  viewModeModel: "realtime",
  viewModeRender: "realtime",
  overlaysModel: DEFAULT_OVERLAYS,
  overlaysRender: DEFAULT_OVERLAYS,
  groundModel: "none",
  groundRender: "none",
  matcapStyle: "studio",
  matcapTint: true,
  denoise: "standard",
  tracer: "auto",
};

export const MIN_BRIGHTNESS = 0.4;
export const MAX_BRIGHTNESS = 2;

const ENVIRONMENTS: Environment[] = ENVIRONMENTS_LIST.map((e) => e.id);
const BACKGROUNDS: Background[] = ["theme", "dark", "grey", "light"];
const TANGENT_EDGES: TangentEdges[] = ["show", "faint", "hide"];

/** The fixed grounds, as 0xRRGGBB. "theme" is absent on purpose: it is answered
 *  by the stylesheet, not by a number here. */
export const BACKGROUND_COLOR: Record<Exclude<Background, "theme">, number> = {
  dark: 0x0e1013,
  grey: 0x4a4f57,
  light: 0xd8dbe0,
};

const KEY = "fundacad.render";

export function asEnvironment(v: unknown): EnvironmentChoice | null {
  if (isHdrEnvironment(v)) return v;
  return ENVIRONMENTS.includes(v as Environment) ? (v as Environment) : null;
}

export const MIN_EXPOSURE = -4;
export const MAX_EXPOSURE = 4;

export function asExposure(v: unknown): number | null {
  return asClamped(v, MIN_EXPOSURE, MAX_EXPOSURE);
}

export function asBackground(v: unknown): Background | null {
  return BACKGROUNDS.includes(v as Background) ? (v as Background) : null;
}

export function asViewMode(v: unknown): ViewMode | null {
  return v === "matcap" || v === "realtime" || v === "pathtraced" ? v : null;
}

export function asMatcapStyle(v: unknown): MatcapStyle | null {
  return MATCAP_STYLES.includes(v as MatcapStyle) ? (v as MatcapStyle) : null;
}

export function asDenoise(v: unknown): Denoise | null {
  return DENOISE_LEVELS.includes(v as Denoise) ? (v as Denoise) : null;
}

export function asTracerPref(v: unknown): TracerPref | null {
  return TRACER_PREFS.includes(v as TracerPref) ? (v as TracerPref) : null;
}

export function asGround(v: unknown): Ground | null {
  return GROUNDS.includes(v as Ground) ? (v as Ground) : null;
}

/** The ground pref of a workspace ("model" or "render"). */
export function groundKey(w: "model" | "render"): "groundModel" | "groundRender" {
  return w === "render" ? "groundRender" : "groundModel";
}

export function asTangentEdges(v: unknown): TangentEdges | null {
  return TANGENT_EDGES.includes(v as TangentEdges) ? (v as TangentEdges) : null;
}

export function asBloom(v: unknown): Bloom | null {
  // Migrate the old named levels to points on the 0..1 slider.
  if (v === "off") return 0;
  if (v === "subtle") return DEFAULT_BLOOM;
  if (v === "strong") return 1;
  return asClamped(v, 0, 1);
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

/** An azimuth folded into (-180, 180]. */
export function asAzimuth(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  let d = v % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d + 0;
}

export function asElevation(v: unknown): number | null {
  return asClamped(v, -90, 90);
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
    envRotation: asAzimuth(o["envRotation"]) ?? DEFAULT_RENDER.envRotation,
    envExposure: asExposure(o["envExposure"]) ?? DEFAULT_RENDER.envExposure,
    envBackground: typeof o["envBackground"] === "boolean" ? o["envBackground"] : DEFAULT_RENDER.envBackground,
    background: asBackground(o["background"]) ?? DEFAULT_RENDER.background,
    brightness: asBrightness(o["brightness"]) ?? DEFAULT_RENDER.brightness,
    bloom: asBloom(o["bloom"]) ?? DEFAULT_RENDER.bloom,
    fov: asFov(o["fov"]) ?? DEFAULT_RENDER.fov,
    aperture: asAperture(o["aperture"]) ?? DEFAULT_RENDER.aperture,
    focusBlur: asFocusBlur(o["focusBlur"]) ?? DEFAULT_RENDER.focusBlur,
    performanceMode: typeof o["performanceMode"] === "boolean" ? o["performanceMode"] : DEFAULT_RENDER.performanceMode,
    potatoMode: typeof o["potatoMode"] === "boolean" ? o["potatoMode"] : DEFAULT_RENDER.potatoMode,
    shadows: typeof o["shadows"] === "boolean" ? o["shadows"] : DEFAULT_RENDER.shadows,
    tangentEdges: asTangentEdges(o["tangentEdges"]) ?? DEFAULT_RENDER.tangentEdges,
    keyAzimuth: asAzimuth(o["keyAzimuth"]) ?? DEFAULT_RENDER.keyAzimuth,
    keyElevation: asElevation(o["keyElevation"]) ?? DEFAULT_RENDER.keyElevation,
    viewModeModel: asViewMode(o["viewModeModel"]) ?? DEFAULT_RENDER.viewModeModel,
    viewModeRender: asViewMode(o["viewModeRender"]) ?? DEFAULT_RENDER.viewModeRender,
    overlaysModel: asOverlays(o["overlaysModel"]),
    overlaysRender: asOverlays(o["overlaysRender"]),
    groundModel: asGround(o["groundModel"]) ?? DEFAULT_RENDER.groundModel,
    groundRender: asGround(o["groundRender"]) ?? DEFAULT_RENDER.groundRender,
    matcapStyle: asMatcapStyle(o["matcapStyle"]) ?? DEFAULT_RENDER.matcapStyle,
    matcapTint: typeof o["matcapTint"] === "boolean" ? o["matcapTint"] : DEFAULT_RENDER.matcapTint,
    denoise: asDenoise(o["denoise"]) ?? DEFAULT_RENDER.denoise,
    tracer: asTracerPref(o["tracer"]) ?? DEFAULT_RENDER.tracer,
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
                : key === "performanceMode" || key === "potatoMode" || key === "envBackground" ? (typeof value === "boolean" ? value : null)
                : key === "envRotation" ? asAzimuth(value)
                : key === "envExposure" ? asExposure(value)
                  : key === "shadows" ? (typeof value === "boolean" ? value : null)
                    : key === "tangentEdges" ? asTangentEdges(value)
                      : key === "keyAzimuth" ? asAzimuth(value)
                        : key === "keyElevation" ? asElevation(value)
                          : key === "viewModeModel" || key === "viewModeRender" ? asViewMode(value)
                          : key === "overlaysModel" || key === "overlaysRender" ? asOverlays(value)
                          : key === "groundModel" || key === "groundRender" ? asGround(value)
                            : key === "matcapStyle" ? asMatcapStyle(value)
                              : key === "matcapTint" ? (typeof value === "boolean" ? value : null)
                                : key === "denoise" ? asDenoise(value)
                                  : key === "tracer" ? asTracerPref(value)
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

/** The settings a saved environment carries, the Environment tab's look. */
export const ENV_SETTING_KEYS = [
  "environment", "envRotation", "envExposure", "envBackground", "background",
  "brightness", "keyAzimuth", "keyElevation", "bloom", "shadows",
] as const satisfies readonly (keyof RenderPrefs)[];
export type EnvSettings = Pick<RenderPrefs, (typeof ENV_SETTING_KEYS)[number]>;

export function envSettingsOf(p: Readonly<RenderPrefs> = current): EnvSettings {
  const out = {} as Record<string, unknown>;
  for (const k of ENV_SETTING_KEYS) out[k] = p[k];
  return out as EnvSettings;
}

/** Untrusted settings narrowed field by field, anything missing taken from `base`. */
export function asEnvSettings(v: unknown, base: Readonly<RenderPrefs> = DEFAULT_RENDER): EnvSettings {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...base };
  for (const k of ENV_SETTING_KEYS) if (k in o) merged[k] = o[k];
  return envSettingsOf(asRenderPrefs(merged));
}

/** Apply a whole saved look; listeners hear once per changed field. */
export function applyEnvSettings(s: EnvSettings): void {
  for (const k of ENV_SETTING_KEYS) setRenderPref(k, s[k] as never);
}

/** Tell the surfaces to redraw with unchanged settings, for when what a
 *  setting names has just become available (an imported panorama loaded). */
export function refreshRenderPrefs(): void {
  for (const fn of listeners) fn();
}

/** Performance mode as the renderer applies it: set by hand, or implied by potato mode. */
export function performanceModeOn(p: Readonly<RenderPrefs> = current): boolean {
  return p.performanceMode || p.potatoMode;
}

/** Subscribe to changes; returns the unsubscribe. */
export function onRenderPrefsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
