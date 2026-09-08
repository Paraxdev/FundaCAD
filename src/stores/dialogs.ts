import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type { WelcomeCallbacks } from "../ui/welcome";
import type { BugReportDeps } from "../ui/bugReporter";

/** Open/closed state for the app-level dialogs that used to build their own
 *  DOM. Each exported opener in ui/ is now a facade over a field here; the
 *  markup lives in components/overlays/*.vue.
 *
 *  Independent fields rather than one `activeDialog` discriminant, because they
 *  legitimately stack: a dialog may be raised over the welcome screen.
 *
 *  Dialogs that gate global shortcuts do it in their component's onMounted/
 *  onUnmounted (composables/useModalGate.ts), NOT here — a store field can be
 *  written from anywhere, including twice, while a mount happens exactly once and
 *  its unmount cannot be forgotten.
 *
 *  markRaw everywhere a value lands here: every request holds a `resolve` closure,
 *  and welcomeCallbacks / bugDeps close over the whole engine graph. None of it may
 *  become a Proxy.
 *
 *  ONLY THE APP'S OWN DIALOGS. A capability's window keeps its open/closed state
 *  in that capability's own directory, next to the component that reads it. Two
 *  used to live here — a 3D-mouse settings flag and a filament-mapping request,
 *  the second of which dragged two type imports from the printer client into
 *  every module that touches a dialog — and a fourth capability with a window
 *  would have meant a third. */

export const useDialogStore = defineStore("dialogs", () => {
  const welcome = ref(false);
  const bugReport = ref(false);
  const preferences = ref(false);

  /** Supplied once by app/engine.ts's mountUi(). Until they arrive the welcome
   *  screen has nothing to call and the bug button has nothing to report on, so
   *  both components stay unrendered. */
  const welcomeCallbacks = shallowRef<WelcomeCallbacks | null>(null);
  const bugDeps = shallowRef<BugReportDeps | null>(null);

  return {
    welcome,
    bugReport,
    preferences,
    welcomeCallbacks,
    bugDeps,
    bindWelcome: (cb: WelcomeCallbacks) => { welcomeCallbacks.value = markRaw(cb); },
    bindBugReporter: (deps: BugReportDeps) => { bugDeps.value = markRaw(deps); },
  };
});
