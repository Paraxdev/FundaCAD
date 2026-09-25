// A click on an Items row, offered to the tool that is waiting for a pick.
//
// Every interactive pick listens on the canvas, so a row click never reached it:
// the row ran its own action instead, and for an Origin plane that action was
// "sketch on it", which quietly abandoned Offset Plane, Datum Plane, Split and
// the rest. A waiting pick registers a taker here, the Browser offers each row
// to it first, and the row's own action runs only when nothing is waiting.
//
// Vue-free and engine-free so the routing is testable on its own.

import type { Plane3, PlaneDef, Vec3 } from "../types";

/** What a row stands for, resolved at click time so a taker needs nothing else. */
export type TreePick =
  | { kind: "basePlane"; plane: Plane3 }
  | { kind: "datumPlane"; id: string; def: PlaneDef }
  | { kind: "datumPoint"; id: string; point: Vec3 }
  | { kind: "datumAxis"; id: string; origin: Vec3; dir: Vec3 }
  | { kind: "body"; id: string }
  | { kind: "bodies"; ids: readonly string[] }
  | { kind: "sketch"; id: string }
  | { kind: "feature"; id: string };

/** `true` when the pick was taken, otherwise the short hint saying why not. */
export type TreePickAnswer = true | string;
export type TreePickTaker = (pick: TreePick) => TreePickAnswer;

const takers: TreePickTaker[] = [];

/** Wait for a row pick. The returned function stops waiting, call it from the
 *  pick's own cleanup so every way out of the pick also leaves here. */
export function awaitTreePick(taker: TreePickTaker): () => void {
  takers.push(taker);
  return () => {
    const i = takers.lastIndexOf(taker);
    if (i >= 0) takers.splice(i, 1);
  };
}

export function treePickWaiting(): boolean {
  return takers.length > 0;
}

const NOUN: Record<TreePick["kind"], string> = {
  basePlane: "a base plane",
  datumPlane: "a datum plane",
  datumPoint: "a datum point",
  datumAxis: "a datum axis",
  body: "a body",
  bodies: "a folder of bodies",
  sketch: "a sketch",
  feature: "a feature",
};

/** The hint for a row a step cannot take: what the row is and what the step wants. */
export function treePickRefusal(pick: TreePick, wanted: string): string {
  return `That row is ${NOUN[pick.kind]}, this step needs ${wanted}`;
}

export interface TreeClickDeps {
  /** A hint when a tool that takes no rows holds the screen, else null. */
  busyHint: () => string | null;
  hint: (text: string) => void;
}

/** "taken" and "refused" both mean the row's own action must not run. */
export type TreeClickRoute = "row" | "taken" | "refused";

export function routeTreeClick(pick: TreePick, deps: TreeClickDeps): TreeClickRoute {
  const taker = takers[takers.length - 1];
  if (taker) {
    const answer = taker(pick);
    if (answer === true) return "taken";
    deps.hint(answer);
    return "refused";
  }
  const busy = deps.busyHint();
  if (busy) {
    deps.hint(busy);
    return "refused";
  }
  return "row";
}

export function resetTreePicks() {
  takers.length = 0;
}
