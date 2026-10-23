import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type { BugReportDeps } from "../ui/bugReporter";

/** Open state of the app's own dialogs, independent fields since dialogs stack. Shortcut gating lives in useModalGate,
 *  never here. markRaw every value: requests hold `resolve` closures and bugDeps closes over the engine graph. */

export const useDialogStore = defineStore("dialogs", () => {
  const bugReport = ref(false);
  const preferences = ref(false);
  const shortcuts = ref(false);

  /** Supplied once by app/engine.ts's mountUi(). Until then the bug button stays unrendered. */
  const bugDeps = shallowRef<BugReportDeps | null>(null);

  return {
    bugReport,
    preferences,
    shortcuts,
    bugDeps,
    openPreferences: () => {
      shortcuts.value = false;
      preferences.value = true;
    },
    bindBugReporter: (deps: BugReportDeps) => {
      bugDeps.value = markRaw(deps);
    },
  };
});
