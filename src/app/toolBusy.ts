import { isChoiceOpen } from "../ui/choice";
import { anyToolBusy, cancelContributedTools } from "../plugins/contrib";
import type { Engine, EngineTools } from "./engine";

/** The tools that hold the screen while `active` and stand down with cancel().
 *  Move is apart because a body selection raises it by itself. */
function modalTools(t: EngineTools) {
  return [
    t.extrude,
    t.edgeFeature,
    t.pressPull,
    t.faceOffset,
    t.draft,
    t.thread,
    t.textOnFace,
    t.hole,
    t.loft,
    t.planeOffset,
    t.datumPose,
    t.lightAim,
    t.pattern,
    t.targetEdit,
    t.revolvePitch,
    t.joint,
    t.mechanism,
  ];
}

/** For a document going away. A plane or point pick ends through the store's rewind instead. */
export function cancelActiveTools(t: EngineTools) {
  for (const tool of modalTools(t)) if (tool.active) standDown(() => tool.cancel());
  // Also when idle: it drops a reopen still pending from the last commit.
  standDown(() => t.move.cancel());
  if (t.measure.active) standDown(() => t.measure.stop());
  if (t.section.picking || t.section.editing) standDown(() => t.section.endEdit());
  cancelContributedTools(standDown);
}

/** One tool that throws must not leave New or Open half done. */
function standDown(cancel: () => void) {
  try {
    cancel();
  } catch (err) {
    console.error("A tool failed to stand down for the next document:", err);
  }
}

/** Plain functions, not reactive state: they are only read at event time. A section counts only while aiming, and
 *  another tool starting confirms a section edit by reading this back. */
export function createToolBusy(
  e: Engine,
): Pick<
  Engine,
  | "toolBusy"
  | "toolOwnsScreen"
  | "toolAtWork"
  | "dropBodyGizmo"
  | "raiseBodyGizmo"
  | "restoreBodyGizmo"
  | "hasBody"
  | "altLeftOwned"
> {
  // One predicate with flags rather than a second list, so the entries can never drift apart.
  const busy = (moveCounts: boolean, modalCounts = true) => {
    const t = e.tools;
    return (
      e.sketch.active ||
      modalTools(t).some((x) => x.active) ||
      (moveCounts && t.move.active) ||
      t.measure.active ||
      t.section.picking ||
      e.planePick ||
      (modalCounts && isChoiceOpen()) ||
      anyToolBusy()
    );
  };
  const raiseBodyGizmo = () => {
    e.tools.move.onClickThrough = (x, y, additive) => {
      e.viewport.clickThrough(x, y, additive);
    };
    e.starters.startMove();
    e.tools.move.markAmbient();
  };
  let stopRestore: (() => void) | null = null;
  return {
    toolBusy: () => busy(true),
    // A body selection raises Move by itself, so counting it would hide every ambient affordance for a body.
    toolOwnsScreen: () => busy(false),
    toolAtWork: () => busy(false, false),
    // Unconditional about why the gizmo is up: a Move started by hand over a body selection is the same gizmo.
    dropBodyGizmo: () => {
      if (e.tools.move.active && e.viewport.selecting === "bodies") e.tools.move.cancel();
    },
    raiseBodyGizmo,
    restoreBodyGizmo: () => {
      stopRestore?.();
      stopRestore = null;
      if (e.viewport.selecting !== "bodies" || !e.viewport.getSelectedBodies().length) return;
      stopRestore = restoreWhenIdle({
        busy: () => busy(true) || e.viewport.selecting !== "bodies",
        selection: () => e.viewport.getSelectedBodies(),
        onDocChange: (fn) => e.store.onDocChange(fn),
        raise: raiseBodyGizmo,
      });
    },
    hasBody: () => (e.store.buildState.result?.mesh.positions.length ?? 0) > 0,
    // The datum pose and light aim dials take Alt on the grab as "no snapping",
    // and a pattern being placed takes it as a free sweep.
    altLeftOwned: () =>
      e.tools.datumPose.active || e.tools.lightAim.active || (e.sketch.active && e.sketch.patternPending()),
  };
}

/** Raises Move again on the body selection once a command is done, unless the selection or document changed. Idle must
 *  hold two frames, since a picker stands down in the frame of its click and hands the pick on in the next. */
export function restoreWhenIdle(o: {
  busy: () => boolean;
  selection: () => readonly string[];
  onDocChange: (fn: () => void) => () => void;
  raise: () => void;
  frame?: (fn: () => void) => number;
  cancelFrame?: (id: number) => void;
}): () => void {
  const frame = o.frame ?? requestAnimationFrame;
  const cancelFrame = o.cancelFrame ?? cancelAnimationFrame;
  const key = (ids: readonly string[]) => [...ids].sort().join(",");
  const was = key(o.selection());
  let handle = 0;
  let idle = 0;
  // onDocChange replays the current document on subscribe, which is not a change.
  let subscribed = false;
  const unsub = o.onDocChange(() => {
    if (subscribed) stop();
  });
  subscribed = true;
  function stop() {
    unsub();
    if (handle) cancelFrame(handle);
    handle = 0;
  }
  const tick = () => {
    handle = 0;
    if (key(o.selection()) !== was) return stop();
    idle = o.busy() ? 0 : idle + 1;
    if (idle >= 2) {
      stop();
      o.raise();
      return;
    }
    handle = frame(tick);
  };
  handle = frame(tick);
  return stop;
}
