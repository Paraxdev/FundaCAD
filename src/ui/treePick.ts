// Offers an Items or Geometry row to a tool waiting for a pick: canvas picks never saw row clicks, and an Origin plane row
// would start a sketch, abandoning Offset Plane, Split and the rest. The row's own action runs only when nothing waits.

import type { Plane3, PlaneDef, Vec3 } from "../types";
import type { EdgeRef } from "../viewport/edgeLines";

/** What a row stands for, resolved at click time so a taker needs nothing else. */
export type TreePick =
  | { kind: "basePlane"; plane: Plane3 }
  | { kind: "datumPlane"; id: string; def: PlaneDef }
  | { kind: "datumPoint"; id: string; point: Vec3 }
  | { kind: "datumAxis"; id: string; origin: Vec3; dir: Vec3 }
  | { kind: "body"; id: string }
  | { kind: "bodies"; ids: readonly string[] }
  | { kind: "sketch"; id: string }
  | { kind: "feature"; id: string }
  | { kind: "face"; faceId: number }
  | { kind: "edge"; edge: EdgeRef };

/** `true` when the pick was taken, otherwise the short hint saying why not. */
export type TreePickAnswer = true | string;
export type TreePickTaker = (pick: TreePick) => TreePickAnswer;

interface PickSession {
  taker: TreePickTaker;
  end: () => void;
  keepsOnRewind: boolean;
  keepsOnCommand: boolean;
}

let session: PickSession | null = null;

/** Rows go to `taker` until the returned release runs. `end` is the pick's cleanup, run when anything else ends the
 *  session, so a taker never outlives its tool. `keepsOnRewind` is for a tool that stays open through an undo or a
 *  redo, so its rows go on with it. `keepsOnCommand` is for a tool a menu command or a shortcut does not close. */
export function awaitTreePick(
  taker: TreePickTaker,
  end: () => void,
  opts: { keepsOnRewind?: boolean; keepsOnCommand?: boolean } = {},
): () => void {
  endPickSession();
  const mine: PickSession = {
    taker,
    end,
    keepsOnRewind: opts.keepsOnRewind ?? false,
    keepsOnCommand: opts.keepsOnCommand ?? false,
  };
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

/** A command or a sketch tool key: ends the live pick unless its tool stays open through commands. */
export function endCommandedPick() {
  if (session && !session.keepsOnCommand) endPickSession();
}

/** Undo, redo or a load: a pick waiting on the old document is stale, unless its tool goes on through the change. */
export function endRewoundPick() {
  if (session && !session.keepsOnRewind) endPickSession();
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
  face: "a face",
  edge: "an edge",
};

/** The hint for a row a step cannot take: what the row is and what the step wants. */
export function treePickRefusal(pick: TreePick, wanted: string): string {
  return `That row is ${NOUN[pick.kind]}, this step needs ${wanted}`;
}

export interface TreeClickDeps {
  /** A hint when a tool that takes no rows holds the screen, else null. */
  busyHint: () => string | null;
  hint: (text: string) => void;
  taken?: () => void;
}

/** "taken" and "refused" both mean the row's own action must not run. */
export type TreeClickRoute = "row" | "taken" | "refused";

export function routeTreeClick(pick: TreePick, deps: TreeClickDeps): TreeClickRoute {
  if (session) {
    const answer = session.taker(pick);
    if (answer === true) {
      deps.taken?.();
      return "taken";
    }
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
