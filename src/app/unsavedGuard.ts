import { clearRecovery } from "../io/recovery";
import { choose } from "../ui/choice";
import { PRODUCT_NAME } from "./channel";
import type { BeforeInstall } from "../ui/updates";
import type { Engine } from "./engine";
import { saveWork, type SaveEngine } from "./documentActions";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** "part.funda*" while there are unsaved changes. */
export function windowTitle(fileName: string, dirty: boolean): string {
  return `${fileName}${dirty ? "*" : ""} · ${PRODUCT_NAME}`;
}

/** Resolves whether to go on; a Save As that was cancelled or failed leaves the document dirty, so that is a no. */
export async function saveFirst(e: SaveEngine, question: string, discardHint: string): Promise<boolean> {
  if (!e.store.dirty) return true;
  const pick = await choose(question, [
    { value: "save", label: "Save" },
    { value: "discard", label: "Don't save", hint: discardHint },
    { value: "cancel", label: "Cancel" },
  ]);
  if (pick === "discard") {
    e.store.markGivenUp();
    return true;
  }
  if (pick !== "save") return false;
  await saveWork(e);
  return !e.store.dirty;
}

/** Save writes the store and never an open sketch's edits, so an open sketch stops the update instead of asking. */
export function beforeUpdate(e: Pick<Engine, "store" | "sketch">): BeforeInstall {
  return async () => {
    if (e.sketch.hasUncommittedEdits) return "sketch";
    const question = `Save changes to ${e.store.fileName} before updating?`;
    return (await saveFirst(e, question, "restart and lose the changes")) ? "go" : "stop";
  };
}

/** The window title follows the document, and closing a window with unsaved
 *  changes asks whether to save them first. */
export function installUnsavedGuard(e: Engine): void {
  let shown = "";
  const applyTitle = () => {
    const title = windowTitle(e.store.fileName, e.store.dirty);
    if (title === shown) return;
    shown = title;
    document.title = title;
    if (isTauri()) {
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
        .catch(() => {});
    }
  };
  e.store.onMeta(applyTitle);
  applyTitle();

  if (!isTauri()) {
    window.addEventListener("beforeunload", (ev) => {
      if (!e.store.dirty) return;
      ev.preventDefault();
      ev.returnValue = "";
    });
    return;
  }

  let asking = false;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    getCurrentWindow().onCloseRequested(async (ev) => {
      if (!e.store.dirty) return;
      if (asking) {
        ev.preventDefault();
        return;
      }
      asking = true;
      await confirmClose(e, ev).finally(() => {
        asking = false;
      });
    }),
  );
}

/** A close with unsaved work: Save, Don't save or Cancel. Don't save gives the work up, so the next start must not
 *  offer its snapshot back. */
export async function confirmClose(e: Pick<Engine, "store">, ev: { preventDefault(): void }): Promise<void> {
  const question = `Save changes to ${e.store.fileName} before closing?`;
  if (!(await saveFirst(e, question, "close and lose the changes"))) ev.preventDefault();
  else if (e.store.dirty) await clearRecovery(e.store.filePath);
}
