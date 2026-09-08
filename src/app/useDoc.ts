import { computed, type ComputedRef } from "vue";
import { useEngine } from "./engineKey";
import type { RebuildState } from "../document/store";
import type { CadDocument } from "../types";

/** Derive a value from the live document.
 *
 *  THIS IS THE ONLY SANCTIONED WAY FOR A COMPONENT TO READ store.document.
 *
 *  `store.document` keeps the same object identity across in-place mutate(),
 *  identity changes only on New/Open/undo/redo, and Vue 3.4+ computeds
 *  short-circuit propagation when the recomputed value is === the previous one. So
 *  `computed(() => (bridge.docVersion.value, store.document))` would re-run on
 *  every edit and then REFUSE TO NOTIFY its dependents, freezing every derived
 *  panel until an undo or a load. That bug is invisible to a happy-path test.
 *
 *  Reading the version ref inside each derived computed, before any early return,
 *  is what avoids it. Two rules follow: never cache store.document in setup()
 *  scope, and never write a Feature built out of reactive state back to the store.
 */
export function useDocValue<T>(fn: (doc: CadDocument) => T): ComputedRef<T> {
  const { store, bridge } = useEngine();
  return computed(() => {
    bridge.docVersion.value; // tracked dependency, read FIRST, unconditionally
    return fn(store.document); // the live, RAW object
  });
}

/** Same contract, against the latest rebuild result. */
export function useBuildValue<T>(fn: (b: RebuildState) => T): ComputedRef<T> {
  const { store, bridge } = useEngine();
  return computed(() => {
    bridge.buildVersion.value;
    return fn(store.buildState);
  });
}

/** Same contract, against file path / dirty state. */
export function useMetaValue<T>(fn: (s: { fileName: string; dirty: boolean }) => T): ComputedRef<T> {
  const { store, bridge } = useEngine();
  return computed(() => {
    bridge.metaVersion.value;
    return fn({ fileName: store.fileName, dirty: store.dirty });
  });
}
