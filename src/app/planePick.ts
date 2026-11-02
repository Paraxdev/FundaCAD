// What a plane row does, in the Items tree and the Geometry list alike.

import type { Engine } from "./engine";
import type { Plane3 } from "../types";
import { routeTreeClick, type TreeClickDeps, type TreeClickRoute, type TreePick } from "../ui/treePick";

export const BASE_PLANES: readonly Plane3[] = ["XY", "XZ", "YZ"];

export type PlanePick = Extract<TreePick, { kind: "basePlane" | "datumPlane" }>;
export type PlaneRowHost = Pick<Engine, "store" | "toolOwnsScreen" | "setStatus"> & {
  sketch: Pick<Engine["sketch"], "active" | "enter">;
};

/** A tool holds the screen but takes no rows (Extrude aiming, a gizmo up, a plugin's pick). A sketch is left out: the
 *  rows keep working inside one. */
function busyHint(e: PlaneRowHost): string | null {
  if (!e.toolOwnsScreen() || e.sketch.active) return null;
  return "The active tool takes its pick in the view, finish it or press Esc";
}

export function treeClickDeps(e: PlaneRowHost): TreeClickDeps {
  return { busyHint: () => busyHint(e), hint: (text) => e.setStatus(text, "") };
}

export function sketchOnPlane(e: PlaneRowHost, pick: PlanePick) {
  if (e.sketch.active) {
    e.setStatus("Finish this sketch before starting another", "");
    return;
  }
  if (pick.kind === "basePlane") e.sketch.enter(pick.plane, e.store);
  else e.sketch.enter(pick.def, e.store, undefined, pick.id);
}

/** A waiting tool takes the row or refuses it, "row" means nothing took it and the row may act for itself. */
export function routePlaneRow(e: PlaneRowHost, pick: PlanePick): TreeClickRoute {
  return routeTreeClick(pick, treeClickDeps(e));
}
