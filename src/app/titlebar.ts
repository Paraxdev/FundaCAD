import { repairableDiagFor } from "../features/repickReference";
import { useUiStore } from "../stores/ui";
import { useTimelineStore } from "../stores/timeline";
import type { Engine } from "./engine";
import { heldEdits, needsSave } from "./documentActions";

/** The half of the titlebar that subscribes to the store; the rest is components/shell/TitleBar.vue. */
export function installTitlebar(e: Engine): void {
  const ui = useUiStore();

  // The store emits before moving the entry between its undo and redo stacks, so read a microtask later. Display
  // changes emit only a build, an import only busy; a plane or sketch eye emits nothing, caught up on the next change.
  const syncUndo = () =>
    queueMicrotask(() => {
      ui.canUndo = e.store.canUndo;
      ui.canRedo = e.store.canRedo;
    });
  e.store.onDocChange(syncUndo);
  e.store.onBuild(syncUndo);
  e.store.onBusy(syncUndo);
  const syncMeta = () => {
    ui.docName = e.store.fileName;
    ui.dirty = needsSave(e);
  };
  e.store.onMeta(syncMeta);
  for (const h of heldEdits(e.tools)) h.onHeldChange(syncMeta);

  useTimelineStore().bind({
    onSelect: (id) => e.selectFeature(id),
    onEdit: (id) => e.editFeature(id),
    // Not cached: a feature repaired since the build must stop offering the repair.
    canRepick: (id) => !!repairableDiagFor(e.store.buildState.result?.diagnostics, id),
    onRepick: (id) => {
      const amb = repairableDiagFor(e.store.buildState.result?.diagnostics, id);
      if (amb?.at) e.starters.repickReference(id, amb.at, amb.kind);
    },
  });
}
