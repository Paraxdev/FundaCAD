// One arrow-key step of the view, shared by both camera rigs.

export const VIEW_STEP = (15 * Math.PI) / 180;
export const VIEW_STEP_FINE = (5 * Math.PI) / 180;
export type StepDir = "left" | "right" | "up" | "down";

/** Azimuth and tilt of one step. Right and up carry the surface nearest the
 *  viewer right and up, the way a drag in that direction does. */
export function stepAngles(dir: StepDir, fine: boolean): [number, number] {
  const a = fine ? VIEW_STEP_FINE : VIEW_STEP;
  return dir === "left" ? [a, 0] : dir === "right" ? [-a, 0] : dir === "up" ? [0, a] : [0, -a];
}
