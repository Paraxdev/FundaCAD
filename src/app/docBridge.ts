import { isProxy, ref, shallowRef, type Ref, type ShallowRef } from "vue";
import type { DocumentStore, BusyState } from "../document/store";

export interface DocBridge {
  docVersion: Ref<number>;
  /** includes `building` ticks */
  buildVersion: Ref<number>;
  /** store.liveFeature */
  editPreviewVersion: Ref<number>;
  /** BusyState is replaced on each emit, so its identity is the change signal. */
  busy: ShallowRef<BusyState>;
  metaVersion: Ref<number>;
  dispose(): void;
}

/** Vue reactivity over the store's channels without proxying the document: undo uses structuredClone (throws on a
 *  Proxy) and the delta protocol diffs features by identity. One counter per channel, so Vue batches the effects. */
export function createDocBridge(store: DocumentStore): DocBridge {
  const docVersion = ref(0);
  const buildVersion = ref(0);
  const editPreviewVersion = ref(0);
  const metaVersion = ref(0);
  const busy = shallowRef(store.busyState);

  // Not onBuildChunk: its one subscriber is app/rebuildBridge.ts, a partial model must never reach a panel.
  const offs = [
    store.onDocChange(() => {
      docVersion.value++;
    }),
    store.onBuild(() => {
      buildVersion.value++;
    }),
    store.onEditPreview(() => {
      editPreviewVersion.value++;
    }),
    store.onBusy((b) => {
      busy.value = b;
    }),
    store.onMeta(() => {
      metaVersion.value++;
    }),
  ];

  if (import.meta.env.DEV) {
    // Fails at the first emit with a stack, rather than as a DataCloneError on some later undo.
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
    editPreviewVersion,
    busy,
    metaVersion,
    dispose: () => offs.forEach((off) => off()),
  };
}
