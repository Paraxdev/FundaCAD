import { computed, type ComputedRef } from "vue";
import { useEngine } from "./engineKey";
import type { RebuildState } from "../document/store";
import type { CadDocument } from "../types";

/** The only sanctioned way for a component to read store.document. The document keeps its identity across mutate(),
 *  and Vue computeds stop propagating an === value, so the version ref is read first and the document is never cached. */
export function useDocValue<T>(fn: (doc: CadDocument) => T): ComputedRef<T> {
  const { store, bridge } = useEngine();
  return computed(() => {
    bridge.docVersion.value;
    return fn(store.document);
  });
}

export function useBuildValue<T>(fn: (b: RebuildState) => T): ComputedRef<T> {
  const { store, bridge } = useEngine();
  return computed(() => {
    bridge.buildVersion.value;
    return fn(store.buildState);
  });
}

export function useMetaValue<T>(fn: (s: { fileName: string; dirty: boolean }) => T): ComputedRef<T> {
  const { store, bridge } = useEngine();
  return computed(() => {
    bridge.metaVersion.value;
    return fn({ fileName: store.fileName, dirty: store.dirty });
  });
}
