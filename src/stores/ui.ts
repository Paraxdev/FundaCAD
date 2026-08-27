import { defineStore } from "pinia";
import { ref } from "vue";

/** Chrome state that used to live as imperative writes to element ids in
 *  index.html — `statusEl.textContent`, `docnameEl.classList.toggle("dirty")`,
 *  `projBtn.textContent`, `selBtn.classList.toggle("active")` and so on.
 *
 *  Everything here is a primitive. Nothing from the document, the build result
 *  or Three.js may be put in a Pinia store: Pinia deep-reactive()s its state,
 *  and a Proxy inside the document breaks structuredClone in the undo snapshot
 *  (store.ts:434) and the reference-identity checks the delta wire protocol
 *  relies on (store.ts:625-636). */
export const useUiStore = defineStore("ui", () => {
  // --- status pill (right of the titlebar) ---
  const statusText = ref("connecting…");
  const statusClass = ref<"" | "connected" | "error">("");
  function setStatus(text: string, cls: "" | "connected" | "error") {
    statusText.value = text;
    statusClass.value = cls;
  }

  // --- document name + dirty marker ---
  const docName = ref("Untitled");
  const dirty = ref(false);

  // --- undo/redo button enablement ---
  const canUndo = ref(false);
  const canRedo = ref(false);

  // --- SOLID / SKETCH context tab ---
  const sketchActive = ref(false);

  // --- what one grid square is worth at the current zoom, in mm ---
  // The grid rescales as you zoom, which means the lines are a ruler whose
  // markings keep changing, and a ruler with no number on it is decoration.
  // Written by the viewport (ground grid) and by sketch mode (sketch lattice,
  // which is also where the cursor snaps); only one of the two is ever drawn.
  const gridStepMm = ref(0);

  // --- view-control pill labels ---
  // Projection cycles Auto -> Persp -> Ortho; the label is the CURRENT mode.
  const projLabel = ref("Auto");
  const selMode = ref<"faces" | "bodies">("faces");

  // --- the `?` keyboard cheat sheet ---
  const shortcutHudOpen = ref(false);

  return {
    statusText, statusClass, setStatus,
    docName, dirty,
    canUndo, canRedo,
    sketchActive,
    gridStepMm,
    projLabel, selMode,
    shortcutHudOpen,
  };
});
