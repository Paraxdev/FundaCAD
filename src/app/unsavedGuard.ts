import { saveDocument } from "../io/files";
import { choose } from "../ui/choice";
import type { Engine } from "./engine";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** "part.funda*" while there are unsaved changes. */
export function windowTitle(fileName: string, dirty: boolean): string {
  return `${fileName}${dirty ? "*" : ""} · FundaCAD`;
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
      const pick = await choose(`Save changes to ${e.store.fileName} before closing?`, [
        { value: "save", label: "Save" },
        { value: "discard", label: "Don't save", hint: "close and lose the changes" },
        { value: "cancel", label: "Cancel" },
      ]).finally(() => { asking = false; });
      if (pick === "discard") return;
      if (pick === "save") {
        await saveDocument(e.store);
        // A Save As that was cancelled or failed leaves the document dirty.
        if (!e.store.dirty) return;
      }
      ev.preventDefault();
    }),
  );
}
