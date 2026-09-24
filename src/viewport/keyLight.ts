// Which way the key light shines from, as the two angles the render settings
// store: azimuth round the up axis from +X and elevation above the ground, in
// degrees. Z is up. Pure numbers so the settings can hold them without three.

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;

/** The unit vector from the model towards the light. */
export function keyDirection(azimuth: number, elevation: number): Vec3 {
  const c = Math.cos(elevation * RAD);
  return [c * Math.cos(azimuth * RAD), c * Math.sin(azimuth * RAD), Math.sin(elevation * RAD)];
}

export function keyAngles(d: Vec3): { azimuth: number; elevation: number } {
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  const z = Math.max(-1, Math.min(1, d[2] / len));
  const flat = Math.hypot(d[0], d[1]);
  return {
    azimuth: flat < 1e-12 ? 0 : Math.atan2(d[1], d[0]) / RAD + 0,
    elevation: Math.asin(z) / RAD + 0,
  };
}

/** Where the rig has always put its key light, over the viewer's right shoulder. */
export const DEFAULT_KEY = keyAngles([40, -60, 80]);
