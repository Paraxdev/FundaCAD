// The one description of how a scene is lit, shared by Realtime and the tracer. The hemisphere goes in only through
// pathtrace/environment.ts when traced, Realtime's own PMREM source when a map is bound, else the HemisphereLight.

import { groundKey, hdrHashOf, type Background, type Ground, type RenderPrefs } from "../ui/renderPrefs";
import { keyDirection, type Vec3 } from "./keyLight";

export type LightRole = "key" | "fill" | "sun";

export interface RigLight {
  role: LightRole;
  /** Unit vector from the model towards the light. */
  direction: Vec3;
  /** sRGB hex. */
  colour: number;
  /** At brightness 1, scale with `scaled`. */
  intensity: number;
  /** Degrees. */
  angularRadius: number;
  /** Only Realtime draws it, the tracer skips it. */
  realtimeOnly: boolean;
}

export interface RigHemisphere {
  sky: number;
  ground: number;
  /** At brightness 1, scale with `scaled`. */
  intensity: number;
  up: Vec3;
}

/** A square catcher plane, the one contactShadow.ts draws. */
export interface RigGround {
  mode: Ground;
  z: number;
  /** World XY of the square's middle. */
  centre: [number, number];
  /** Side length of the square. */
  extent: number;
  albedo: number;
}

/** Where the catcher sits in a workspace, from the viewport's model floor. */
export interface GroundFloor {
  workspace: "model" | "render";
  z: number;
  centre: [number, number];
  extent: number;
}

export interface RigEnvironment {
  /** The room or panorama cache key, null for none or a panorama still loading. */
  key: string | null;
  rotation: number;
  exposure: number;
  /** `key` plus the hemisphere folded into the capture, null when `key` is. */
  fullKey: string | null;
}

export interface LightRig {
  environment: RigEnvironment;
  /** An imported panorama lights the scene on its own: the key, the fill and the hemisphere are at zero. */
  hdrAlone: boolean;
  hemisphere: RigHemisphere;
  lights: RigLight[];
  brightness: number;
  background: Background;
  ground: RigGround;
}

/** The lighting at brightness 1. */
export const KEY_INTENSITY = 2.0;
export const FILL_INTENSITY = 0.6;
export const HEMI_INTENSITY = 0.6;
export const HEMI_SKY = 0xbfd4ff;
export const HEMI_GROUND = 0x202428;
export const SUN_ANGULAR_RADIUS = 1;
export const FILL_DIRECTION: Vec3 = unit([-50, 40, 20]);
export const HEMI_UP: Vec3 = [0, 1, 0];
/** A shadow catcher: it shows only the light it does not get, so its own
 *  colour never reaches the picture, a mid grey keeps its bounce light neutral. */
export const GROUND_ALBEDO = 0.5;

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** What `p` lights with as a cache key, or null for none, which includes an
 *  imported panorama whose pixels have not loaded yet. */
export function environmentKeyOf(p: Readonly<RenderPrefs>, loaded: (hash: string) => boolean): string | null {
  if (p.environment === "none") return null;
  const hash = hdrHashOf(p.environment);
  if (!hash) return p.environment;
  if (!loaded(hash)) return null;
  return `${p.environment}|${p.envRotation.toFixed(1)}|${p.envExposure.toFixed(2)}`;
}

export function hemisphereKey(h: RigHemisphere): string {
  return `${h.sky.toString(16)}:${h.ground.toString(16)}:${h.intensity.toFixed(4)}:${h.up.join(",")}`;
}

/** A light level with the brightness setting applied, the one place it is. */
export function scaled(rig: Pick<LightRig, "brightness">, intensity: number): number {
  return intensity * rig.brightness;
}

/** True while a loaded panorama is the environment, which then lights the scene with no lights added. */
export function litByHdrAlone(p: Readonly<RenderPrefs>, loaded: (hash: string) => boolean): boolean {
  const hash = hdrHashOf(p.environment);
  return hash !== null && loaded(hash);
}

export function buildLightRig(
  p: Readonly<RenderPrefs>,
  loaded: (hash: string) => boolean,
  floor?: Readonly<GroundFloor> | null,
): LightRig {
  const alone = litByHdrAlone(p, loaded);
  const on = alone ? 0 : 1;
  const hemisphere: RigHemisphere = {
    sky: HEMI_SKY,
    ground: HEMI_GROUND,
    intensity: HEMI_INTENSITY * on,
    up: HEMI_UP,
  };
  const key = environmentKeyOf(p, loaded);
  return {
    hdrAlone: alone,
    environment: {
      key,
      rotation: p.envRotation,
      exposure: p.envExposure,
      fullKey: key === null ? null : `${key}|${hemisphereKey(hemisphere)}`,
    },
    hemisphere,
    lights: [
      {
        role: "key",
        direction: keyDirection(p.keyAzimuth, p.keyElevation),
        colour: 0xffffff,
        intensity: KEY_INTENSITY * on,
        angularRadius: SUN_ANGULAR_RADIUS,
        realtimeOnly: false,
      },
      {
        role: "fill",
        direction: FILL_DIRECTION,
        colour: 0xffffff,
        intensity: FILL_INTENSITY * on,
        angularRadius: SUN_ANGULAR_RADIUS,
        realtimeOnly: false,
      },
    ],
    brightness: p.brightness,
    background: p.background,
    ground: floor
      ? {
          mode: p[groundKey(floor.workspace)],
          z: floor.z,
          centre: [floor.centre[0], floor.centre[1]],
          extent: floor.extent,
          albedo: GROUND_ALBEDO,
        }
      : { mode: "none", z: 0, centre: [0, 0], extent: 0, albedo: GROUND_ALBEDO },
  };
}

export function lightOf(rig: LightRig, role: LightRole): RigLight | undefined {
  return rig.lights.find((l) => l.role === role);
}
