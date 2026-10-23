// How the viewport is lit and what it is drawn against. Sanitised per field, so a garbage `background` does not cost
// the lighting. No Three import: this is what the user asked for, not part of the renderer.

import { readSetting } from "./storedSetting";
import { DEFAULT_KEY } from "../viewport/keyLight";
import { DEFAULT_OVERLAYS, asOverlays, type OverlayState } from "../viewport/overlayKinds";

/** What a metal reflects; with nothing to reflect it renders near black. Generated in the renderer from emissive
 *  boxes, no HDR file or network. "none" is the flat look, best for reading geometry. */
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

/** In offered order, with a note under each name. `swatch` is a CSS gradient conveying the mood, since real previews
 *  would cost six PMREM passes to open a tab. */
export const ENVIRONMENTS_LIST: readonly {
  id: Environment;
  label: string;
  note: string;
  swatch: string;
}[] = [
  {
    id: "studio",
    label: "Studio",
    note: "Neutral room, even light",
    swatch: "radial-gradient(circle at 35% 28%, #f4f6f8 0%, #9aa3ad 45%, #3d4249 100%)",
  },
  {
    id: "softbox",
    label: "Soft box",
    note: "One big light, product shot",
    swatch: "radial-gradient(circle at 28% 22%, #ffffff 0%, #7d858e 38%, #14171b 100%)",
  },
  {
    id: "warm",
    label: "Warm key",
    note: "Warm light, cool shade",
    swatch: "radial-gradient(circle at 68% 26%, #ffd9a0 0%, #b98a55 42%, #2b3550 100%)",
  },
  {
    id: "dusk",
    label: "Dusk",
    note: "Dark, with a bright rim",
    swatch: "radial-gradient(circle at 50% 86%, #d8e8ff 0%, #2a3550 26%, #0a0c12 70%)",
  },
  {
    id: "bright",
    label: "Bright room",
    note: "High key, white walls",
    swatch: "radial-gradient(circle at 45% 30%, #ffffff 0%, #e6eaef 55%, #b9c0c8 100%)",
  },
  {
    id: "none",
    label: "Flat",
    note: "No reflections, easiest to read",
    swatch: "linear-gradient(160deg, #6a727b 0%, #4a5058 100%)",
  },
];

/** "theme" follows the app palette; the rest are fixed grounds for looking at a part. */
export type Background = "theme" | "dark" | "grey" | "light";

/** 0 (off) to 1 (full). Realtime blooms only faces with an Emission (GlowMask in realtimePipeline.ts). */
export type Bloom = number;

export const DEFAULT_BLOOM = 0.4;

/** `threshold` is the linear luminance a masked pixel must reach to spill, falling as the slider rises. */
export function bloomSettings(amount: number): { strength: number; radius: number; threshold: number } {
  const a = Math.min(1, Math.max(0, amount));
  // Squared since three r186: its UnrealBloomPass glow grows linearly with strength,
  // r180's grew with its square, and 0.7 * a^2 matched r180 at every slider position.
  return { strength: 0.7 * a * a, radius: 0.3 + a * 0.3, threshold: 2.0 - a * 1.2 };
}

/** Whether the path tracer's frame gets a bloom pass, which is not masked to glowing faces.
 *  Realtime asks PostChain.glows instead. */
export function bloomWanted(amount: number, bloomable: boolean): boolean {
  if (!(amount > 0)) return false;
  return bloomable || bloomSettings(amount).threshold < 1;
}

/** Not 1:1: `emissiveIntensity` multiplies a linear colour, so a slider topping out at 1 could never push a mid-tone
 *  past the bloom threshold. */
export const MAX_EMISSIVE_INTENSITY = 4;

/** How an edge where two faces meet tangentially is drawn, such as a fillet's boundaries, which run across what looks
 *  like one continuous surface. */
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

/** How much the realtime view draws. Auto behaves as Standard until the machine
 *  can be measured; High is refused on a low power tier (viewport/realtimePipeline.ts). */
export const REALTIME_QUALITY_PREFS = ["auto", "standard", "high"] as const;
export type RealtimeQualityPref = (typeof REALTIME_QUALITY_PREFS)[number];

export interface RenderPrefs {
  environment: EnvironmentChoice;
  /** An imported panorama's turn about the up axis, degrees, and its exposure
   *  in stops. Built in rooms ignore both. */
  envRotation: number;
  envExposure: number;
  /** Draw the imported panorama behind the model instead of the ground colour. */
  envBackground: boolean;
  background: Background;
  /** Environment brightness, 0.4 to 2: the environment's light and reflections, a built in room's key, fill and
   *  hemisphere with it so they cannot drift apart. An imported panorama has no other light to scale. */
  brightness: number;
  bloom: Bloom;
  /** Perspective lens in degrees, 20 (long, flat) to 65 (wide). Orthographic views ignore it. */
  fov: number;
  /** Depth of field as an f-stop, 1.4 to 22. Does nothing while `focusBlur` is zero. */
  aperture: number;
  /** 0 to 1, zero by default: at zero the depth-of-field pass is not built, and lasting blur would fight picking. */
  focusBlur: number;
  /** Forces the lightweight render (flat alpha glass, low pixel ratio, fewer emitter lights), for a dedicated GPU that
   *  passes `detectLowPower` but still stutters. */
  performanceMode: boolean;
  /** The lowest render, for software rendering in a VM. Implies performance mode without writing it, so turning it off
   *  restores the user's own setting. */
  potatoMode: boolean;
  /** Real cast shadows from the key light. Off by default, since the app draws a clean shadowless view; ignored on the
   *  lightweight tier. */
  shadows: boolean;
  /** Faint by default: a near-sharp corner's patch borders ran across its flat top and read as a false curve. */
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
  /** None in both by default, for the reason `shadows` is off. */
  groundModel: Ground;
  groundRender: Ground;
  /** Matcap's sphere, and whether it keeps body colours (false is plain). */
  matcapStyle: MatcapStyle;
  matcapTint: boolean;
  denoise: Denoise;
  tracer: TracerPref;
  realtimeQuality: RealtimeQualityPref;
  /** Path traced draws the Realtime look while the view moves or an edit lands,
   *  and traces again once it rests. Off keeps the noisy trace up throughout. */
  realtimeWhileMoving: boolean;
}

/** Photographic f-stops rather than 0..1, since people know which way f/2 is from f/11. */
export const APERTURE_STOPS: readonly number[] = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];
export const MIN_FOV = 15;
export const MAX_FOV = 70;

export const DEFAULT_RENDER: RenderPrefs = {
  // On although it costs a cubemap and a PMREM pass at start-up: a metal rendering black is not a defensible default.
  environment: "studio",
  envRotation: 0,
  envExposure: 0,
  envBackground: false,
  background: "theme",
  brightness: 1,
  // On, gently: it costs a pass regardless, and it is what makes an emissive material read as a light.
  bloom: DEFAULT_BLOOM,
  fov: 45,
  aperture: 4,
  focusBlur: 0,
  // Off: auto-detect already spares the machines that cannot cope.
  performanceMode: false,
  potatoMode: false,
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
  realtimeQuality: "auto",
  // On: a trace that restarts noisy on every frame of an orbit reads as broken.
  realtimeWhileMoving: true,
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

export function asRealtimeQuality(v: unknown): RealtimeQualityPref | null {
  return REALTIME_QUALITY_PREFS.includes(v as RealtimeQualityPref) ? (v as RealtimeQualityPref) : null;
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

/** Clamp into range, or null for a non-number: an out-of-range value is one somebody meant. */
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

/** Clamped rather than refused: the nearest legal value is closer to what was meant than the default. */
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
    realtimeQuality: asRealtimeQuality(o["realtimeQuality"]) ?? DEFAULT_RENDER.realtimeQuality,
    realtimeWhileMoving:
      typeof o["realtimeWhileMoving"] === "boolean" ? o["realtimeWhileMoving"] : DEFAULT_RENDER.realtimeWhileMoving,
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
    key === "environment"
      ? asEnvironment(value)
      : key === "background"
        ? asBackground(value)
        : key === "bloom"
          ? asBloom(value)
          : key === "fov"
            ? asFov(value)
            : key === "aperture"
              ? asAperture(value)
              : key === "focusBlur"
                ? asFocusBlur(value)
                : key === "performanceMode" || key === "potatoMode" || key === "envBackground"
                  ? typeof value === "boolean"
                    ? value
                    : null
                  : key === "envRotation"
                    ? asAzimuth(value)
                    : key === "envExposure"
                      ? asExposure(value)
                      : key === "shadows"
                        ? typeof value === "boolean"
                          ? value
                          : null
                        : key === "tangentEdges"
                          ? asTangentEdges(value)
                          : key === "keyAzimuth"
                            ? asAzimuth(value)
                            : key === "keyElevation"
                              ? asElevation(value)
                              : key === "viewModeModel" || key === "viewModeRender"
                                ? asViewMode(value)
                                : key === "overlaysModel" || key === "overlaysRender"
                                  ? asOverlays(value)
                                  : key === "groundModel" || key === "groundRender"
                                    ? asGround(value)
                                    : key === "matcapStyle"
                                      ? asMatcapStyle(value)
                                      : key === "matcapTint" || key === "realtimeWhileMoving"
                                        ? typeof value === "boolean"
                                          ? value
                                          : null
                                        : key === "denoise"
                                          ? asDenoise(value)
                                          : key === "tracer"
                                            ? asTracerPref(value)
                                            : key === "realtimeQuality"
                                              ? asRealtimeQuality(value)
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
  "environment",
  "envRotation",
  "envExposure",
  "envBackground",
  "background",
  "brightness",
  "keyAzimuth",
  "keyElevation",
  "bloom",
  "shadows",
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

export function onRenderPrefsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
