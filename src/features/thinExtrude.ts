import type { Feature, SketchEntity } from "../types";

/** The curves a thin wall can follow, the rest the engine refuses with a reason. */
const WALL_CURVES = new Set<SketchEntity["type"]>(["line", "arc", "circle", "rectangle", "polygon", "slot", "projected"]);

export const THIN_DEFAULTS = { distance: 10, thickness: 2 } as const;

/** A thin extrude of a sketch that has no closed area to extrude: a wall
 *  along every curve it has, or null when it has no curve a wall can follow. */
export function thinExtrudeOf(features: readonly Feature[], sketchId: string, id: string): Feature | null {
  const sk = features.find((f) => f.id === sketchId);
  if (sk?.type !== "sketch") return null;
  const entities = (sk as { entities?: SketchEntity[] }).entities ?? [];
  const curves = entities
    .filter((e) => WALL_CURVES.has(e.type) && e.construction !== true && typeof e.id === "string" && e.id !== "")
    .map((e) => e.id as string);
  if (!curves.length) return null;
  return {
    id, type: "extrude", sketch: sketchId, distance: THIN_DEFAULTS.distance, operation: "new",
    thin: true, curves, thickness: THIN_DEFAULTS.thickness, side: "center",
  };
}
