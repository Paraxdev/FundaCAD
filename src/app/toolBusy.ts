import { isChoiceOpen } from "../ui/choice";
import { anyToolBusy } from "../plugins/contrib";
import type { Engine } from "./engine";

/** Guard predicates checked at the top of every start* tool and interactive helper:
 *  they can't fire mid-sketch / mid-drag.
 *
 *  Plain functions rather than reactive state, deliberately. `toolBusy` is only read
 *  at event time and nothing in the UI is disabled by it, so making it reactive
 *  would mean polling eleven `.active` fields every frame or bolting
 *  change-notification onto ten tool classes for no present gain.
 *
 *  Cross-section is the one entry that is NOT `.active`. It became a MODE you keep
 *  working inside, so counting it as busy made every command in the app return
 *  silently for as long as the section was up, the same invisible dead-app symptom
 *  the stale `planePick` flag used to cause. Its modal half, `picking`, genuinely
 *  does own the gesture. The section stands its own handle down while another tool
 *  runs by reading this predicate back. */
export function createToolBusy(
  e: Engine,
): Pick<Engine, "toolBusy" | "toolOwnsScreen" | "dropBodyGizmo" | "raiseBodyGizmo" | "restoreBodyGizmo" | "hasBody"> {
  // ONE predicate, read two ways. The only difference is whether the Move
  // gizmo counts, and it is spelled as a parameter rather than as a second list
  // so the other fifteen entries can never drift apart.
  const busy = (moveCounts: boolean) => {
    const t = e.tools;
    return (
      e.sketch.active || t.extrude.active || t.edgeFeature.active || t.pressPull.active ||
      t.faceOffset.active || t.draft.active || t.thread.active || t.hole.active || t.loft.active || t.planeOffset.active || t.datumPose.active || t.lightAim.active ||
      (moveCounts && t.move.active) || t.pattern.active ||
      t.measure.active || t.section.picking || t.targetEdit.active ||
      t.revolvePitch.active || t.joint.active ||
      e.planePick || isChoiceOpen() ||
      // A plugin's tool holds the window exactly as one of the above does.
      // Without this the app believes it is idle while a contributed tool
      // owns the pick: every Escape handler here is gated off, a second tool
      // starts over the top of the first, and the user has two prompts and
      // one key that answers neither.
      anyToolBusy()
    );
  };
  const raiseBodyGizmo = () => {
    e.tools.move.onClickThrough = (x, y, additive) => {
      e.viewport.clickThrough(x, y, additive);
    };
    e.starters.startMove();
  };
  let stopRestore: (() => void) | null = null;
  return {
    toolBusy: () => busy(true),
    // See the note on Engine.toolOwnsScreen: a body selection RAISES the Move
    // gizmo by itself (app/viewportWiring.onBodySelectionChange), so counting
    // it here would mean no ambient affordance could ever show for a body.
    toolOwnsScreen: () => busy(false),
    // See the note on Engine.dropBodyGizmo. Deliberately unconditional about
    // WHY the gizmo is up: an explicitly started Move over a body selection is
    // the same gizmo on the same bodies, so there is nothing for a caller to
    // tell apart, and a Move started over anything else is not in bodies mode.
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
    // True when the current rebuild produced a solid body (something to modify).
    hasBody: () => (e.store.buildState.result?.mesh.positions.length ?? 0) > 0,
  };
}

/** Wait out a command started over a body selection, then raise the Move gizmo
 *  on that selection again, as if the command had never been reached for. Gives
 *  up when the selection or the document changes: a commit is not a cancel.
 *
 *  Idle has to hold for two frames, because a picker stands down in the frame
 *  it takes its click and hands the pick on in the next one. */
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
