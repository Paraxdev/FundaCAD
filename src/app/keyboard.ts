import { installKeymap } from "../input/keymap";
import { isEditableTarget, isPageSelectAll } from "../ui/focus";
import { exportSelection } from "../io/files";
import { saveWork, saveWorkAs } from "./documentActions";
import { SKETCH_TOOLS } from "./actionTables";
import { logError, toggleConsole } from "../ui/logStore";
import { isSessionEnded } from "../document/session";
import { useDialogStore } from "../stores/dialogs";
import { isMac } from "../input/platform";
import { useShellStore } from "../stores/shell";
import { useCommandPaletteStore } from "../stores/commandPalette";
import type { Engine } from "./engine";
import { pickedFeatureIds } from "./featureRows";

/** The keymap plus window level handlers that bypass it, such as the file shortcuts that must work mid sketch. */
export function installKeyboard(e: Engine): void {
  installKeymap(
    (a) => {
      // while sketching, the sketch tool owns its tool keys + Esc/Enter
      if (e.sketch.active && SKETCH_TOOLS.has(a)) return;
      if (a === "escape") {
        const t = e.tools;
        if (
          !e.sketch.active &&
          !t.extrude.active &&
          !t.edgeFeature.active &&
          !t.pressPull.active &&
          !t.loft.active &&
          !t.mirror.active &&
          !t.planeOffset.active &&
          !t.datumPose.active
        ) {
          e.viewport.clearSelection();
          e.selectFeature(null);
        }
        return;
      }
      e.handleAction(a);
    },
    () => (e.sketch.active ? "sketch" : "model"),
  );

  // Tab cycles an open area box's filter; not in the keymap, since otherwise Tab must stay the browser's focus key.
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (!e.viewport.cycleAreaFilter()) return;
    ev.preventDefault();
  });

  // A selected face is removed and healed; otherwise only a feature the user picked is deleted, never the profile
  // that exiting a sketch auto selects.
  window.addEventListener("keydown", (ev) => {
    if (isEditableTarget(ev.target)) return;
    if (e.toolBusy()) return;
    if (ev.key !== "Delete" && ev.key !== "Backspace") return;
    if (e.deleteSelectedFace()) return;
    if (e.selectedFeature && e.selectedFeatureExplicit) {
      e.store.removeFeatures(pickedFeatureIds(e));
      e.selectFeature(null);
    }
  });

  window.addEventListener("keydown", (ev) => {
    if (isPageSelectAll(ev)) ev.preventDefault();
  });

  // Ctrl+` works inside text fields too: the full error text is most wanted while typing into the box that refused it.
  window.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    if (ev.key !== "`" && ev.code !== "Backquote") return;
    ev.preventDefault();
    toggleConsole();
  });

  // Failures with no toast of their own would otherwise exist only in devtools, where a user reporting a bug never looks.
  window.addEventListener("error", (ev) => {
    logError(ev.error ?? ev.message, {
      source: "window",
      detail: ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    if (isSessionEnded(ev.reason)) return;
    logError(ev.reason, { source: "promise" });
  });

  // file shortcuts, which work even mid sketch
  window.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const k = ev.key.toLowerCase();
    if (ev.altKey) {
      // Ctrl+Alt first, or Ctrl+Alt+S would also save. macOS Option types another character, so the physical key counts
      // there; elsewhere only the typed letter, since AltGr reports Ctrl+Alt on Windows.
      const mac = isMac();
      const is = (letter: string) => k === letter || (mac && ev.code === `Key${letter.toUpperCase()}`);
      if (is("s")) {
        ev.preventDefault();
        useShellStore().toggleItems();
      } else if (is("h")) {
        ev.preventDefault();
        useShellStore().toggleHistory();
      }
      return;
    }
    if (k === "f" && !ev.shiftKey) {
      ev.preventDefault();
      useCommandPaletteStore().toggle(e.sketch.active ? "sketch" : "model");
    } else if (k === "n") {
      ev.preventDefault();
      void e.newDocument();
    } else if (k === "o") {
      ev.preventDefault();
      void e.openDoc();
    } else if (k === "s" && ev.shiftKey) {
      ev.preventDefault();
      void saveWorkAs(e);
    } else if (k === "s") {
      ev.preventDefault();
      void saveWork(e);
    } else if (k === "e") {
      ev.preventDefault();
      void exportSelection(e.store, e.geometry, e.viewport);
    }
    // Ctrl+, sits here rather than in the keymap so it works mid sketch.
    else if (ev.key === ",") {
      ev.preventDefault();
      useDialogStore().openPreferences();
    }
  });
}
