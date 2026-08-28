import { installKeymap } from "../input/keymap";
import { isEditableTarget } from "../ui/focus";
import { saveDocument, saveDocumentAs, exportModel } from "../io/files";
import { SKETCH_TOOLS } from "./actionTables";
import { logError, toggleConsole } from "../ui/logStore";
import { useDialogStore } from "../stores/dialogs";
import type { Engine } from "./engine";

/** Global keyboard: the MCAD keymap plus the two window-level handlers that
 *  don't go through it (Delete, and the Ctrl-file shortcuts that must work even
 *  mid-sketch). */
export function installKeyboard(e: Engine): void {
  installKeymap(
    (a) => {
      // while sketching, the sketch tool owns its tool keys + Esc/Enter
      if (e.sketch.active && SKETCH_TOOLS.has(a)) return;
      if (a === "escape") {
        const t = e.tools;
        if (!e.sketch.active && !t.extrude.active && !t.edgeFeature.active && !t.pressPull.active && !t.loft.active && !t.planeOffset.active) {
          e.viewport.clearSelection();
          e.selectFeature(null);
        }
        return;
      }
      // everything else — including the once-dead M/Move and T/Trim keys — routes
      // through the same dispatcher the ribbon and command palette use
      e.handleAction(a);
    },
    () => (e.sketch.active ? "sketch" : "model"),
  );

  // Tab, while an area box is open, cycles what that box will take. Registered
  // here rather than in the keymap because it only exists during a drag — the
  // rest of the time Tab is the browser's own focus key and must stay that.
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (!e.viewport.cycleAreaFilter()) return;
    ev.preventDefault();
  });

  // delete: a selected FACE → remove it and heal the solid (defeature — works on
  // imported geometry, where there's no feature to delete); otherwise delete the
  // selected timeline feature.
  window.addEventListener("keydown", (ev) => {
    if (isEditableTarget(ev.target)) return; // typing in a field, not a shortcut
    if (e.toolBusy()) return;
    if (ev.key !== "Delete" && ev.key !== "Backspace") return;
    if (e.deleteSelectedFace()) return;
    if (e.selectedFeature) {
      e.store.removeFeature(e.selectedFeature);
      e.selectFeature(null);
    }
  });

  // The console, on Ctrl+`. Backquote alone used to open an orientation wheel;
  // that pie is gone, and every view it offered is still one click away on the
  // view cube, the Look submenu and the command palette.
  //
  // Live inside text fields too, unlike most shortcuts, because the moment you
  // most want the full error text is while you are typing a value into the box
  // that just refused one.
  window.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    if (ev.key !== "`" && ev.code !== "Backquote") return;
    ev.preventDefault();
    toggleConsole();
  });

  // Anything that escapes to the window. These are the failures with no toast
  // at all — a listener that threw, a rejected promise nobody awaited — so
  // without this they exist only in devtools, which is exactly where a user
  // reporting a bug is not looking.
  window.addEventListener("error", (ev) => {
    logError(ev.error ?? ev.message, {
      source: "window",
      detail: ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    logError(ev.reason, { source: "promise" });
  });

  // file shortcuts (work everywhere, even mid-sketch)
  window.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const k = ev.key.toLowerCase();
    if (k === "n") { ev.preventDefault(); void e.newDocument(); }
    else if (k === "o") { ev.preventDefault(); void e.openDoc(); }
    else if (k === "s" && ev.shiftKey) { ev.preventDefault(); void saveDocumentAs(e.store); }
    else if (k === "s") { ev.preventDefault(); void saveDocument(e.store); }
    else if (k === "e") { ev.preventDefault(); void exportModel(e.store, e.geometry); }
    // Ctrl+, is the conventional Preferences key and belongs with the file
    // shortcuts rather than the keymap: like them it has to work mid-sketch,
    // and unlike them it is punctuation, which the keymap's tool bindings are
    // not.
    else if (ev.key === ",") { ev.preventDefault(); useDialogStore().preferences = true; }
  });
}
