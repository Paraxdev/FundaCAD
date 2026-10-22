import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type { BugReportDeps } from "../ui/bugReporter";

/** Open/closed state for the app-level dialogs that used to build their own
 *  DOM. Each exported opener in ui/ is now a facade over a field here; the
 *  markup lives in components/overlays/*.vue.
 *
 *  Independent fields rather than one `activeDialog` discriminant, because they
 *  legitimately stack: a dialog may be raised over another.
 *
 *  Dialogs that gate global shortcuts do it in their component's onMounted/
 *  onUnmounted (composables/useModalGate.ts), NOT here, a store field can be
 *  written from anywhere, including twice, while a mount happens exactly once and
 *  its unmount cannot be forgotten.
 *
 *  markRaw everywhere a value lands here: every request holds a `resolve` closure,
 *  and bugDeps closes over the whole engine graph. None of it may
 *  become a Proxy.
 *
 *  ONLY THE APP'S OWN DIALOGS. A capability's window keeps its open/closed state
 *  in that capability's own directory, next to the component that reads it. Two
 *  used to live here, a 3D-mouse settings flag and a plugin's request object,
 *  the second of which dragged two type imports from that plugin into
 *  every module that touches a dialog, and a fourth capability with a window
 *  would have meant a third. */

export const useDialogStore = defineStore("dialogs", () => {
  const bugReport = ref(false);
  const preferences = ref(false);

  /** Supplied once by app/engine.ts's mountUi(). Until they arrive the bug
   *  button has nothing to report on, so it stays unrendered. */
  const bugDeps = shallowRef<BugReportDeps | null>(null);

  return {
    bugReport,
    preferences,
    bugDeps,
    bindBugReporter: (deps: BugReportDeps) => {
      bugDeps.value = markRaw(deps);
    },
  };
});
