import { defineStore } from "pinia";
import { ref } from "vue";
import type { SelectPolicy } from "../viewport/clickIntent";
import type { ViewMode } from "../ui/renderPrefs";

/** Chrome state, primitives only. Pinia deep-reactive()s state, and a Proxy in the document breaks structuredClone in
 *  the undo snapshot and the delta wire protocol's reference identity checks (document/store.ts). */
export const useUiStore = defineStore("ui", () => {
  const docName = ref("Untitled");
  const dirty = ref(false);

  const canUndo = ref(false);
  const canRedo = ref(false);

  const sketchActive = ref(false);

  // In mm. The grid rescales with zoom, so its lines need a number to be a ruler. Written by the viewport (ground grid)
  // or sketch mode (sketch lattice, where the cursor snaps); only one of the two is ever drawn.
  const gridStepMm = ref(0);

  // Projection cycles Auto, Persp, Ortho; the label is the CURRENT mode.
  const projLabel = ref("Auto");
  const selMode = ref<SelectPolicy>("auto");
  /** See-through: the model is translucent and an area box reaches what is behind it. A lit view bar button keeps it
   *  findable. */
  const xray = ref(false);
  const wireframe = ref(false);
  const viewMode = ref<ViewMode>("realtime");
  /** What the path tracer is doing, for the paused hint on the view switch. */
  const traceState = ref("off");

  // The viewport stutters under the full render (viewport/stutterWatch.ts).
  const lowPerformance = ref(false);
  const lowPerformanceDismissed = ref(false);

  // The `?` keyboard cheat sheet.
  const shortcutHudOpen = ref(false);

  return {
    docName,
    dirty,
    canUndo,
    canRedo,
    sketchActive,
    gridStepMm,
    projLabel,
    selMode,
    xray,
    wireframe,
    viewMode,
    traceState,
    lowPerformance,
    lowPerformanceDismissed,
    shortcutHudOpen,
  };
});
