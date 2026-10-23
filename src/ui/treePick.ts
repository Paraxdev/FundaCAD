// Offers an Items row click to a tool waiting for a pick: canvas picks never saw row clicks, and an Origin plane row
// would start a sketch, abandoning Offset Plane, Split and the rest. The row's own action runs only when nothing waits.

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

interface PickSession {
  taker: TreePickTaker;
  end: () => void;
}

let session: PickSession | null = null;

/** Rows go to `taker` until the returned release runs. `end` is the pick's cleanup, run when anything else ends the
 *  session, so a taker never outlives its tool. */
export function awaitTreePick(taker: TreePickTaker, end: () => void): () => void {
  endPickSession();
  const mine: PickSession = { taker, end };
  session = mine;
  return () => {
    if (session === mine) session = null;
  };
}

/** End the live pick session, if any, through its own cleanup. */
export function endPickSession() {
  const s = session;
  if (!s) return;
  session = null;
  s.end();
}

export function treePickWaiting(): boolean {
  return session !== null;
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
  if (session) {
    const answer = session.taker(pick);
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
  session = null;
}
