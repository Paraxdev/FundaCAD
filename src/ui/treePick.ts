// Offers an Items or Geometry row to a tool waiting for a pick: canvas picks never saw row clicks, and an Origin plane row
// would start a sketch, abandoning Offset Plane, Split and the rest. The row's own action runs only when nothing waits.

import { t } from "../i18n";
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

/** What a taker did with a pick it took, so the words come in the person's language. */
export interface TreePickDone {
  done: "added" | "takenOut" | "mirrorPlane";
  /** Edges one pick added or took out, more than one when its tangent chain came along. */
  edges?: number;
}

/** `true` or a `done` when the pick was taken, otherwise the short hint saying why not. */
export type TreePickAnswer = true | string | TreePickDone;
export type TreePickTaker = (pick: TreePick) => TreePickAnswer;

interface PickSession {
  taker: TreePickTaker;
  end: () => void;
  keepsOnRewind: boolean;
  keepsOnCommand: boolean;
  batch: ((run: () => void) => void) | null;
}

let session: PickSession | null = null;
const begun = new Set<() => void>();

/** `fn` runs each time a pick session begins, until the returned stop runs. */
export function onPickSessionBegin(fn: () => void): () => void {
  begun.add(fn);
  return () => begun.delete(fn);
}

/** Rows go to `taker` until the returned release runs. `end` is the pick's cleanup, run when anything else ends the
 *  session, so a taker never outlives its tool. `keepsOnRewind` is for a tool that stays open through an undo or a
 *  redo, so its rows go on with it. `keepsOnCommand` is for a tool a menu command or a shortcut does not close. `batch`
 *  wraps a run of rows taken together, so the tool can redraw once at its end rather than once a row. */
export function awaitTreePick(
  taker: TreePickTaker,
  end: () => void,
  opts: { keepsOnRewind?: boolean; keepsOnCommand?: boolean; batch?: (run: () => void) => void } = {},
): () => void {
  endPickSession();
  const mine: PickSession = {
    taker,
    end,
    keepsOnRewind: opts.keepsOnRewind ?? false,
    keepsOnCommand: opts.keepsOnCommand ?? false,
    batch: opts.batch ?? null,
  };
  session = mine;
  for (const fn of begun) fn();
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

/** A pick a command would end holds an edit of a step back too; one that keeps on command gives way with its tool. */
export function pickHoldsEdits(): boolean {
  return session !== null && !session.keepsOnCommand;
}

export type TreePickWant =
  | "face"
  | "flatFace"
  | "roundFace"
  | "modelFlatFace"
  | "edge"
  | "faceOrEdge"
  | "axisFaceOrEdge"
  | "planeOrFace"
  | "planeOrFlatFace"
  | "bodyPlaneOrFlatFace"
  | "body"
  | "oneBody"
  | "datumPoint"
  | "sketchProfile"
  | "axisOrStraightEdge";

export function treePickRefusal(pick: TreePick, wanted: TreePickWant): string {
  return t("pick.refused", { row: pick.kind, wanted });
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
    if (typeof answer !== "string") {
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

export interface NamedPick {
  pick: TreePick;
  /** What the pick is called aloud, "Flat face 6 of Bracket". Read only when one pick is taken, a run says a count. */
  readonly name: string;
}

export interface OfferDeps extends TreeClickDeps {
  say: (text: string) => void;
}

type DoneWord = TreePickDone["done"] | "other";

function takenWords(taken: readonly NamedPick[], words: readonly DoneWord[], edges: number): string {
  if (taken.length > 1) {
    return t("pick.doneRun", { n: taken.length, done: words.every((w) => w === words[0]) ? words[0]! : "other" });
  }
  const name = taken[0]!.name;
  return edges > 1
    ? t("pick.doneChain", { name, done: words[0]!, n: edges })
    : t("pick.done", { name, done: words[0]! });
}

/** Offers each pick in turn, as clicks would, until one is refused or the session ends, and says what was taken.
 *  A refusal goes out with the taken words in one hint, so neither cancels the other. */
export function offerPicks(offers: readonly NamedPick[], deps: OfferDeps): void {
  const took: NamedPick[] = [];
  const words: DoneWord[] = [];
  let edges = 0;
  let refusal = null as string | null;
  const run = () => {
    for (const o of offers) {
      if (!session) return;
      const answer = session.taker(o.pick);
      if (typeof answer === "string") {
        refusal = answer;
        return;
      }
      took.push(o);
      words.push(answer === true ? "other" : answer.done);
      edges = answer === true ? 0 : (answer.edges ?? 0);
    }
  };
  if (session?.batch) session.batch(run);
  else run();
  if (took.length) deps.taken?.();
  const taken = took.length ? takenWords(took, words, edges) : null;
  if (refusal !== null) deps.hint(taken === null ? refusal : t("pick.takenThenRefused", { taken, refusal }));
  else if (taken !== null) deps.say(taken);
}

export function resetTreePicks() {
  session = null;
}
