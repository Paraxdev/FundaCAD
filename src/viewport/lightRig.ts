// The one description of how a scene is lit, shared by Realtime and the tracer.
// Hemisphere placement rule: in Path traced the hemisphere is added only by
// pathtrace/environment.ts, in Realtime only in its own PMREM source when an
// environment map is bound, and the HemisphereLight stays when none is bound.

import { hdrHashOf, type Background, type RenderPrefs } from "../ui/renderPrefs";
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

export interface RigGround {
  mode: "none" | "shadow";
  z: number;
  extent: number;
  albedo: number;
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
  hemisphere: RigHemisphere;
  lights: RigLight[];
  brightness: number;
  background: Background;
  ground: RigGround;
}

/** The lighting at brightness 1, the light level the app has always had. */
export const KEY_INTENSITY = 2.0;
export const FILL_INTENSITY = 0.6;
export const HEMI_INTENSITY = 0.6;
export const HEMI_SKY = 0xbfd4ff;
export const HEMI_GROUND = 0x202428;
export const SUN_ANGULAR_RADIUS = 1;
export const FILL_DIRECTION: Vec3 = unit([-50, 40, 20]);
export const HEMI_UP: Vec3 = [0, 1, 0];

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

export function buildLightRig(p: Readonly<RenderPrefs>, loaded: (hash: string) => boolean): LightRig {
  const hemisphere: RigHemisphere = { sky: HEMI_SKY, ground: HEMI_GROUND, intensity: HEMI_INTENSITY, up: HEMI_UP };
  const key = environmentKeyOf(p, loaded);
  return {
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
        intensity: KEY_INTENSITY,
        angularRadius: SUN_ANGULAR_RADIUS,
        realtimeOnly: false,
      },
      {
        role: "fill",
        direction: FILL_DIRECTION,
        colour: 0xffffff,
        intensity: FILL_INTENSITY,
        angularRadius: SUN_ANGULAR_RADIUS,
        realtimeOnly: false,
      },
    ],
    brightness: p.brightness,
    background: p.background,
    ground: { mode: "none", z: 0, extent: 0, albedo: 0.5 },
  };
}

export function lightOf(rig: LightRig, role: LightRole): RigLight | undefined {
  return rig.lights.find((l) => l.role === role);
}
