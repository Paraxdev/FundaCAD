import { saveDocument, saveDocumentAs, exportSelection, importModel } from "../io/files";
import { contributedMenus } from "../plugins/contrib";
import { toggleShortcutHUD } from "../input/shortcuts";
import { checkForUpdates, showAbout } from "../ui/updates";
import { useDialogStore } from "../stores/dialogs";
import { setWorkspace } from "../ui/workspace";
import { openExternal } from "../ui/welcome";
import type { MenuDef } from "../ui/menu";
import type { Engine } from "./engine";

const ISSUES_URL = "https://github.com/Paraxdev/fundacad/issues";

/** A contribution naming an existing menu appends to it, otherwise it creates one before `before`. Copies the item
 *  arrays, which are the plugin's own and would grow once per render if pushed into. */
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

/** `disabled` and `checked` are thunks, re-evaluated every time a menu opens. */
export function buildMenubar(e: Engine): MenuDef[] {
  return withContributions([
    {
      label: "File",
      items: [
        { label: "Home", onClick: () => e.ui.home.open() },
        { separator: true, label: "" },
        { label: "New", shortcut: "Ctrl+N", onClick: () => void e.newDocument() },
        { label: "Open…", shortcut: "Ctrl+O", onClick: () => void e.openDoc() },
        { separator: true, label: "" },
        { label: "Import Mesh…", onClick: () => void importModel(e.store, e.geometry) },
        { separator: true, label: "" },
        { label: "Save", shortcut: "Ctrl+S", onClick: () => void saveDocument(e.store) },
        { label: "Save As…", shortcut: "Ctrl+Shift+S", onClick: () => void saveDocumentAs(e.store) },
        { separator: true, label: "" },
        { label: "Export…", shortcut: "Ctrl+E", onClick: () => void exportSelection(e.store, e.geometry, e.viewport) },
      ],
    },
    {
      label: "Edit",
      items: [
        {
          label: "Undo",
          shortcut: "Ctrl+Z",
          disabled: () => !(e.sketch.active ? e.sketch.canUndoSketch : e.store.canUndo),
          onClick: () => e.doUndo(),
        },
        {
          label: "Redo",
          shortcut: "Ctrl+Y",
          disabled: () => !(e.sketch.active ? e.sketch.canRedoSketch : e.store.canRedo),
          onClick: () => e.doRedo(),
        },
        { separator: true, label: "" },
        {
          label: "Delete",
          shortcut: "Del",
          // A selected face is deletable too. getSelectedFaceIds, since selectedFacesForPressPull walks every triangle.
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
        // No ellipsis: it opens a workspace, not a window.
        { label: "Materials", onClick: () => setWorkspace("render") },
        {
          label: "Preferences…",
          shortcut: "Ctrl+,",
          onClick: () => {
            useDialogStore().preferences = true;
          },
        },
      ],
    },
    {
      label: "Help",
      items: [
        { label: "Keyboard Shortcuts", shortcut: "?", onClick: () => toggleShortcutHUD() },
        { label: "Issue Tracker", onClick: () => void openExternal(ISSUES_URL) },
        { separator: true, label: "" },
        { label: "Check for Updates…", onClick: () => void checkForUpdates(true) },
        { label: "About FundaCAD", onClick: () => void showAbout() },
      ],
    },
  ] as MenuDef[]).filter((m) => m.items.length > 0);
}
