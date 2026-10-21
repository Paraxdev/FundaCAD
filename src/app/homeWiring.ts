import type { DocumentStore } from "../document/store";
import { setSaveFolder } from "../io/saveFolder";

/** Any open closes Home and ends the Save As folder hint of the document before.
 *  emitOpen fires before the new document is applied, so this reads nothing from the store. */
export function wireHomeOnOpen(store: Pick<DocumentStore, "onOpen">, home: { close(): void }): () => void {
  return store.onOpen(() => {
    home.close();
    setSaveFolder(null);
  });
}
