import { saveDocument, saveDocumentAs, exportModel, importModel } from "../io/files";
import { contributedMenus } from "../plugins/contrib";
import { toggleShortcutHUD } from "../input/shortcuts";
import { checkForUpdates, showAbout } from "../ui/updates";
import { useDialogStore } from "../stores/dialogs";
import { setWorkspace } from "../ui/workspace";
import { openExternal } from "../ui/welcome";
import type { MenuDef } from "../ui/menu";
import type { Engine } from "./engine";

/** Where a bug report goes. The reporter puts the report on the clipboard and
 *  says to paste it into a new issue, so the app has to be able to say where. */
const ISSUES_URL = "https://github.com/Paraxdev/fundacad/issues";

/** Fold what the running plugins add into the app's own tree.
 *
 *  Two shapes, both wanted, and both arrived at from real cases rather than
 *  imagined ones. A contribution naming a menu that EXISTS appends its rows to
 *  it, which is how a capability adds two lines to File. A contribution naming
 *  one that does not CREATES it, placed before whatever `before` names, which is
 *  how a capability owns the whole of View, and why View disappears when that
 *  capability is off, without anything here knowing that View is its.
 *
 *  Rows are appended in the order the plugins started, and a contribution
 *  brings its own leading separator if it wants one. Neither is a policy this
 *  file is in a position to have: it cannot tell a row that belongs at the top
 *  of File from one that belongs at the bottom.
 *
 *  A copy, never a mutation: `menus` is rebuilt on every open, but the ITEM
 *  arrays inside a contribution are the plugin's own and pushing into them would
 *  grow them once per menu render. */
function withContributions(menus: MenuDef[]): MenuDef[] {
  const out = menus.map((m) => ({ ...m, items: [...m.items] }));
  for (const c of contributedMenus()) {
    const existing = out.find((m) => m.label === c.menu);
    if (existing) {
      existing.items.push(...c.items);
      continue;
    }
    const at = c.before ? out.findIndex((m) => m.label === c.before) : -1;
    const fresh: MenuDef = { label: c.menu, items: [...c.items] };
    if (at >= 0) out.splice(at, 0, fresh);
    else out.push(fresh);
  }
  return out;
}

/** The File / Edit / Help tree, plus whatever the running plugins add.
 *
 *  `disabled` and `checked` are THUNKS, not values: Menubar re-evaluates them
 *  every time a menu opens, so "Undo" greys out correctly without anything
 *  having to push state at it. A contributed row's thunks are the plugin's own
 *  and are called the same way, which is what lets a capability tick its own
 *  mode without this file holding a handle on the module that knows it. */
export function buildMenubar(e: Engine): MenuDef[] {
  return withContributions([
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
          // A selected FACE is deletable too (defeature), onClick has always
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
        // No ellipsis any more: it opens a workspace, not a window, and the
        // three dots are a promise that something will come up over this.
        { label: "Materials", onClick: () => setWorkspace("render") },
        { label: "Preferences…", shortcut: "Ctrl+,", onClick: () => { useDialogStore().preferences = true; } },
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
        { label: "About FundaCAD", onClick: () => void showAbout() },
      ],
    },
  ] as MenuDef[]).filter((m) => m.items.length > 0);
}
