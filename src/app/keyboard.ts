import { installKeymap } from "../input/keymap";
import { isEditableTarget, isPageSelectAll, widgetOwnsKey } from "../ui/focus";
import { exportSelection } from "../io/files";
import { saveWork, saveWorkAs } from "./documentActions";
import { SKETCH_TOOLS } from "./actionTables";
import { logError, toggleConsole } from "../ui/logStore";
import { isSessionEnded } from "../document/session";
import { useDialogStore } from "../stores/dialogs";
import { latinKey, matchChord } from "../input/platform";
import { useShellStore } from "../stores/shell";
import { useCommandPaletteStore } from "../stores/commandPalette";
import { interfaceSizeKey } from "../ui/interfaceSize";
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
    if (ev.key !== "Tab" || ev.ctrlKey || ev.metaKey || ev.altKey || widgetOwnsKey(ev)) return;
    if (!e.viewport.cycleAreaFilter()) return;
    ev.preventDefault();
  });

  // A selected face is removed and healed; otherwise only a feature the user picked is deleted, never the profile
  // that exiting a sketch auto selects.
  window.addEventListener("keydown", (ev) => {
    if (isEditableTarget(ev.target) || widgetOwnsKey(ev)) return;
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

  // Registered at boot ahead of every tool's own capture listener, so the pattern count never reads Ctrl+Minus.
  window.addEventListener("keydown", interfaceSizeKey, true);

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

  // File shortcuts and the platform chords work even mid sketch, and inside text fields: the console's full error text
  // is most wanted while typing into the box that refused it.
  window.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    // Chords first, or Ctrl+Alt+S would also save. AltGr reports Ctrl+Alt on Windows, so its letters never match.
    const chord = matchChord(ev);
    if (chord) {
      ev.preventDefault();
      if (chord === "items") useShellStore().toggleItems();
      else if (chord === "history") useShellStore().toggleHistory();
      else toggleConsole();
      return;
    }
    if (ev.altKey) return;
    const k = latinKey(ev);
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
