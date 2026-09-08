import { isProxy, ref, shallowRef, type Ref, type ShallowRef } from "vue";
import type { DocumentStore, BusyState } from "../document/store";

export interface DocBridge {
  /** Bumped on every onDocChange emit. */
  docVersion: Ref<number>;
  /** Bumped on every onBuild emit, including `building` ticks. */
  buildVersion: Ref<number>;
  /** BusyState is replaced wholesale on each emit, so its identity is already a
   *  correct change signal, no counter needed. */
  busy: ShallowRef<BusyState>;
  /** Bumped on onMeta, file path + dirty flag only. */
  metaVersion: Ref<number>;
  dispose(): void;
}

/** Turns DocumentStore's callback channels into Vue reactivity WITHOUT putting
 *  the document itself behind a proxy.
 *
 *  That constraint is not stylistic. `store.ts` snapshots undo with
 *  structuredClone, which throws DataCloneError on a Proxy; it does a
 *  reference-equality staleness check on sketch features; and the delta wire
 *  protocol diffs features by object identity, so a proxy would make projection
 *  refreshes silently stop shipping. The document stays raw and authoritative;
 *  components observe a version counter instead.
 *
 *  One subscription per channel, installed once at engine construction, never
 *  per component. Emit is a synchronous unbatched fan-out, so N component
 *  subscriptions would mean N synchronous callbacks per edit; one counter bump
 *  is O(1) and Vue's scheduler batches the resulting effects. */
export function createDocBridge(store: DocumentStore): DocBridge {
  const docVersion = ref(0);
  const buildVersion = ref(0);
  const metaVersion = ref(0);
  const busy = shallowRef(store.busyState);

  // Deliberately NOT subscribing to onBuildChunk / onBuildAbort. store.ts
  // documents that the chunk channel has exactly one legitimate subscriber
  // (app/rebuildBridge.ts) because store.buildState.result keeps pointing at the
  // PREVIOUS document for the whole stream, a partial model must never become
  // visible to a panel.
  const offs = [
    store.onDocChange(() => { docVersion.value++; }),
    store.onBuild(() => { buildVersion.value++; }),
    store.onBusy((b) => { busy.value = b; }),
    store.onMeta(() => { metaVersion.value++; }),
  ];

  if (import.meta.env.DEV) {
    // Catches a leaked proxy at the first emit after it happens, with a stack,
    // rather than as a DataCloneError on some later undo.
    store.onDocChange((doc) => {
      if (isProxy(doc) || doc.features.some((f) => isProxy(f))) {
        throw new Error(
          "[docBridge] a reactive Proxy reached CadDocument, this breaks undo " +
            "(structuredClone) and the delta protocol's reference identity. " +
            "Use toRaw()/markRaw() at whatever put it there.",
        );
      }
    });
  }

  return {
    docVersion,
    buildVersion,
    busy,
    metaVersion,
    dispose: () => offs.forEach((off) => off()),
  };
}
