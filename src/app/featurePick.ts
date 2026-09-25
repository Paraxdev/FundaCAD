import type { Engine } from "./engine";
import type { Feature } from "../types";
import type { TreePick } from "../ui/treePick";

type Of<T extends string> = Extract<Feature, { type: T }>;

/** A feature row (Items or History) as a pick, a datum placed where the viewport draws it. */
export function featurePick(e: Pick<Engine, "store" | "datumPlaneDef">, f: Feature): TreePick {
  if (f.type === "datumPlane") return { kind: "datumPlane", id: f.id, def: e.datumPlaneDef(f as Of<"datumPlane">) };
  const m = e.store.buildState.result?.datumMarks?.[f.id];
  if (f.type === "datumPoint") {
    const p = f as Of<"datumPoint">;
    return { kind: "datumPoint", id: f.id, point: m && m.kind === "point" ? m.position : p.point };
  }
  if (f.type === "datumAxis") {
    const a = f as Of<"datumAxis">;
    return m && m.kind === "axis"
      ? { kind: "datumAxis", id: f.id, origin: m.origin, dir: m.dir }
      : { kind: "datumAxis", id: f.id, origin: a.origin, dir: a.dir };
  }
  if (f.type === "sketch") return { kind: "sketch", id: f.id };
  return { kind: "feature", id: f.id };
}
