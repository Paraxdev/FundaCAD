import { saveDocument, saveDocumentAs, exportModel, exportPrintProject, importModel } from "../io/files";
import { openInOrca, sendToPrinter } from "../print/printFlow";
import { activePrinterId } from "../print/printerClient";
import { getSpaceMouseMode, setSpaceMouseMode } from "../input/spacemouse";
import { toggleShortcutHUD } from "../input/shortcuts";
import { checkForUpdates, showAbout } from "../ui/updates";
import { useDialogStore } from "../stores/dialogs";
import { openExternal } from "../ui/welcome";
import type { MenuDef } from "../ui/menu";
import type { Engine } from "./engine";

/** Where a bug report goes. The reporter puts the report on the clipboard and
 *  says to paste it into a new issue, so the app has to be able to say where. */
const ISSUES_URL = "https://github.com/Paraxdev/neocad/issues";

/** The File / Edit / View / Help tree.
 *
 *  `disabled` and `checked` are THUNKS, not values: Menubar re-evaluates them
 *  every time a menu opens, so "Undo" greys out correctly without anything
 *  having to push state at it. */
export function buildMenubar(e: Engine): MenuDef[] {
  return [
    {
      label: "File",
      items: [
        { label: "New", shortcut: "Ctrl+N", onClick: () => void e.newDocument() },
        { label: "Open…", shortcut: "Ctrl+O", onClick: () => void e.openDoc() },
        { separator: true, label: "" },
        { label: "Import Mesh…", onClick: () => void importModel(e.store, e.geometry) },
        { separator: true, label: "" },
        { label: "Save", shortcut: "Ctrl+S", onClick: () => void saveDocument(e.store) },
        { label: "Save As…", shortcut: "Ctrl+Shift+S", onClick: () => void saveDocumentAs(e.store) },
        { separator: true, label: "" },
        { label: "Export…", shortcut: "Ctrl+E", onClick: () => void exportModel(e.store, e.geometry) },
        { label: "Export for Print (3MF)…", onClick: () => void exportPrintProject(e.store, e.geometry) },
        { separator: true, label: "" },
        { label: "Open in OrcaSlicer…", onClick: () => void openInOrca(e.store, e.geometry) },
        { label: "Send to Printer…", onClick: () => void sendToPrinter(e.store, e.geometry) },
        { label: "Camera…", onClick: () => void e.ui.panels.showCameraPanel(activePrinterId()) },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", shortcut: "Ctrl+Z", disabled: () => !(e.sketch.active ? e.sketch.canUndoSketch : e.store.canUndo), onClick: () => e.doUndo() },
        { label: "Redo", shortcut: "Ctrl+Y", disabled: () => !(e.sketch.active ? e.sketch.canRedoSketch : e.store.canRedo), onClick: () => e.doRedo() },
        { separator: true, label: "" },
        {
          label: "Delete",
          shortcut: "Del",
          // A selected FACE is deletable too (defeature) — onClick has always
          // tried that first, but the predicate only asked about features, so
          // the menu greyed out the one case the Del key still handled.
          // getSelectedFaceIds, not selectedFacesForPressPull: this runs on
          // every menu render and the full call walks every triangle.
          disabled: () => !e.selectedFeature && e.viewport.getSelectedFaceIds().length === 0,
          onClick: () => {
            if (e.deleteSelectedFace()) return;
            if (e.selectedFeature) {
              e.store.removeFeature(e.selectedFeature);
              e.selectFeature(null);
            }
          },
        },
        {
          label: "Suppress / Unsuppress",
          disabled: () => !e.selectedFeature,
          onClick: () => e.selectedFeature && e.store.toggleSuppress(e.selectedFeature),
        },
        { separator: true, label: "" },
        { label: "Preferences…", shortcut: "Ctrl+,", onClick: () => { useDialogStore().preferences = true; } },
      ],
    },
    {
      label: "View",
      items: [
        { label: "SpaceMouse: Move Object", checked: () => getSpaceMouseMode() === "object", onClick: () => setSpaceMouseMode("object") },
        { label: "SpaceMouse: Move Camera", checked: () => getSpaceMouseMode() === "camera", onClick: () => setSpaceMouseMode("camera") },
        { separator: true, label: "" },
        { label: "3D Mouse Settings…", onClick: () => e.ui.spaceMouseSettings.open() },
      ],
    },
    {
      label: "Help",
      items: [
        { label: "Keyboard Shortcuts", shortcut: "?", onClick: () => toggleShortcutHUD() },
        { label: "Welcome Screen", onClick: () => e.ui.welcome.open() },
        { label: "Issue Tracker", onClick: () => void openExternal(ISSUES_URL) },
        { separator: true, label: "" },
        { label: "Check for Updates…", onClick: () => void checkForUpdates(true) },
        { label: "About SindriCAD", onClick: () => void showAbout() },
      ],
    },
  ];
}
