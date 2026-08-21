import { ambiguousDiagFor } from "../features/repickReference";
import { useUiStore } from "../stores/ui";
import { useTimelineStore } from "../stores/timeline";
import type { Engine } from "./engine";

/** Feeds the titlebar's reactive state and wires the timeline's callbacks.
 *
 *  What used to be here — the click handlers for undo/redo, the view-control
 *  pill cluster and the unit <select>, plus the direct textContent/classList
 *  writes for #docname and the button disabled flags — now lives in
 *  components/shell/TitleBar.vue and ViewControls.vue. This module is the half
 *  that has to stay outside a component: it subscribes to the store. */
export function installTitlebar(e: Engine): void {
  const ui = useUiStore();

  e.store.onDocChange(() => {
    ui.canUndo = e.store.canUndo;
    ui.canRedo = e.store.canRedo;
  });
  e.store.onMeta(() => {
    ui.docName = e.store.fileName;
    ui.dirty = e.store.dirty;
  });

  useTimelineStore().bind({
    onSelect: (id) => e.selectFeature(id),
    onEdit: (id) => e.editFeature(id),
    // Read the diagnostics off the LATEST build each time rather than caching: the
    // menu opens long after the build, and a feature repaired in between must stop
    // offering the repair.
    canRepick: (id) => !!ambiguousDiagFor(e.store.buildState.result?.diagnostics, id),
    onRepick: (id) => {
      const amb = ambiguousDiagFor(e.store.buildState.result?.diagnostics, id);
      if (amb?.at) e.starters.repickReference(id, amb.at, amb.kind);
    },
  });
}
