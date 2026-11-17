import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type { BugReportDeps } from "../ui/bugReporter";
import type { ModelDescription } from "../ui/modelDescription";

/** Open state of the app's own dialogs, independent fields since dialogs stack. Shortcut gating lives in useModalGate,
 *  never here. markRaw every value: requests hold `resolve` closures and bugDeps closes over the engine graph. */

export const useDialogStore = defineStore("dialogs", () => {
  const bugReport = ref(false);
  const preferences = ref(false);
  const shortcuts = ref(false);
  /** The category Preferences opens on or switches to, taken and cleared by the dialog; null is Appearance. */
  const prefsCategory = ref<string | null>(null);
  /** What Describe model shows, taken when it opened; null is closed. */
  const describeModel = shallowRef<ModelDescription | null>(null);

  /** Supplied once by app/engine.ts's mountUi(). Until then the bug button stays unrendered. */
  const bugDeps = shallowRef<BugReportDeps | null>(null);

  return {
    bugReport,
    preferences,
    shortcuts,
    prefsCategory,
    describeModel,
    bugDeps,
    openPreferences: (category?: string) => {
      shortcuts.value = false;
      prefsCategory.value = category ?? null;
      preferences.value = true;
    },
    bindBugReporter: (deps: BugReportDeps) => {
      bugDeps.value = markRaw(deps);
    },
  };
});
