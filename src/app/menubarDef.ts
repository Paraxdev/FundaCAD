import { saveDocument, saveDocumentAs, exportModel, exportPrintProject, importModel } from "../io/files";
import { printingEnabled, spaceMouseEnabled } from "../plugins/registry";
import { toggleShortcutHUD } from "../input/shortcuts";
import { checkForUpdates, showAbout } from "../ui/updates";
import { useDialogStore } from "../stores/dialogs";
import { openExternal } from "../ui/welcome";
import type { MenuDef, MenuItem } from "../ui/menu";
import type { Engine } from "./engine";

/** Where a bug report goes. The reporter puts the report on the clipboard and
 *  says to paste it into a new issue, so the app has to be able to say where. */
const ISSUES_URL = "https://github.com/Paraxdev/fundacad/issues";

/** Rows a capability owns, present only while that capability is running.
 *
 *  Left OUT rather than greyed out. A greyed row is a promise that the thing
 *  exists and could be reached from here, which is the wrong thing to say about
 *  something that is not running at all.
 *
 *  A spread of nothing rather than a flag on each row, because a menu whose
 *  every row belongs to one capability has to be able to disappear as well, and
 *  the empty array falls out of the same shape. buildMenubar drops any menu
 *  left with no items. */
const when = <T>(on: boolean, items: T[]): T[] => (on ? items : []);

// The 3D mouse's module, once something has needed it.
//
// `checked` below is synchronous — Menubar calls it while opening the menu —
// so the mode cannot be read through a dynamic import at that moment. It is
// cached here instead, and primed when the menu is built. That import is not a
// download: the capability itself loaded the same chunk when it started, so
// this resolves from the module cache. Before it lands, neither mode is ticked,
// which is the honest answer to "which is selected" from something that has not
// read the setting yet.
type SpaceMouseModule = typeof import("../input/spacemouse");
let spaceMouse: SpaceMouseModule | null = null;
const loadSpaceMouse = (): Promise<SpaceMouseModule> =>
  import("../input/spacemouse").then((m) => (spaceMouse = m));
const spaceMouseMode = (): "object" | "camera" | null =>
  spaceMouse ? spaceMouse.getSpaceMouseMode() : null;
const setSpaceMouseMode = (mode: "object" | "camera") => {
  if (spaceMouse) spaceMouse.setSpaceMouseMode(mode);
  else void loadSpaceMouse().then((m) => m.setSpaceMouseMode(mode));
};

/** The File / Edit / View / Help tree.
 *
 *  `disabled` and `checked` are THUNKS, not values: Menubar re-evaluates them
 *  every time a menu opens, so "Undo" greys out correctly without anything
 *  having to push state at it. */
export function buildMenubar(e: Engine): MenuDef[] {
  if (spaceMouseEnabled() && !spaceMouse) void loadSpaceMouse();
  return ([
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
        // Imported when used, not when the menu is built: the slicer bridge,
        // the printer client and the status pill are a chunk of their own, and
        // a machine with no printer should never pay to parse it.
        ...when<MenuItem>(printingEnabled(), [
          {
            label: "Open in OrcaSlicer…",
            onClick: () =>
              void import("../print/printFlow").then((m) => m.openInOrca(e.store, e.geometry)),
          },
          {
            label: "Send to Printer…",
            onClick: () =>
              void import("../print/printFlow").then((m) => m.sendToPrinter(e.store, e.geometry)),
          },
          {
            label: "Camera…",
            onClick: () =>
              void import("../print/printerClient").then((m) =>
                e.ui.panels.showCameraPanel(m.activePrinterId()),
              ),
          },
        ]),
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
    // Every row of View belongs to the 3D mouse today, so with that capability
    // off the menu is not empty, it is absent.
    ...when<MenuDef>(spaceMouseEnabled(), [
      {
        label: "View",
        items: [
          { label: "SpaceMouse: Move Object", checked: () => spaceMouseMode() === "object", onClick: () => setSpaceMouseMode("object") },
          { label: "SpaceMouse: Move Camera", checked: () => spaceMouseMode() === "camera", onClick: () => setSpaceMouseMode("camera") },
          { separator: true, label: "" },
          { label: "3D Mouse Settings…", onClick: () => { useDialogStore().spaceMouse = true; } },
        ],
      },
    ]),
    {
      label: "Help",
      items: [
        { label: "Keyboard Shortcuts", shortcut: "?", onClick: () => toggleShortcutHUD() },
        { label: "Welcome Screen", onClick: () => e.ui.welcome.open() },
        { label: "Issue Tracker", onClick: () => void openExternal(ISSUES_URL) },
        { separator: true, label: "" },
        { label: "Check for Updates…", onClick: () => void checkForUpdates(true) },
        { label: "About FundaCAD", onClick: () => void showAbout() },
      ],
    },
  ] as MenuDef[]).filter((m) => m.items.length > 0);
}
