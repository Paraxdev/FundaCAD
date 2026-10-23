import { saveDocument, saveDocumentAs, exportSelection, importModel } from "../io/files";
import { contributedMenus } from "../plugins/contrib";
import { toggleShortcutHUD } from "../input/shortcuts";
import { checkForUpdates, showAbout } from "../ui/updates";
import { useDialogStore } from "../stores/dialogs";
import { setWorkspace } from "../ui/workspace";
import { MANUAL_URL, openExternal } from "../ui/welcome";
import { openReportDialog } from "../ui/bugReporter";
import { ideaUrl, REPO_URL } from "../ui/reportText";
import type { MenuDef } from "../ui/menu";
import { beforeUpdate } from "./unsavedGuard";
import { PRODUCT_NAME } from "./channel";
import { allCommands } from "../ui/commands";
import { analysisFlags } from "../ui/railActive";
import type { Engine } from "./engine";

const ISSUES_URL = `${REPO_URL}/issues`;

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

const ANALYSIS_ITEMS = [
  { id: "draft-analysis", label: "Overhang" },
  { id: "zebra", label: "Zebra" },
  { id: "curvature", label: "Curvature" },
  { id: "component-colors", label: "Body Colors" },
];

function viewItems(e: Engine): MenuDef["items"] {
  const view = allCommands()
    .filter((c) => c.group === "View")
    .map((c) => ({ label: c.label, ...(c.key ? { shortcut: c.key } : {}), onClick: () => e.handleAction(c.id) }));
  const analysis = ANALYSIS_ITEMS.map((a) => ({
    label: a.label,
    checked: () => analysisFlags(e.viewport)[a.id] === true,
    onClick: () => e.handleAction(a.id),
  }));
  return [...view, { separator: true, label: "" }, ...analysis];
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
            useDialogStore().openPreferences();
          },
        },
      ],
    },
    { label: "View", items: viewItems(e) },
    {
      label: "Help",
      items: [
        { label: "Keyboard Shortcuts", shortcut: "?", onClick: () => toggleShortcutHUD() },
        { label: "Manual", onClick: () => void openExternal(MANUAL_URL) },
        { separator: true, label: "" },
        { label: "Report a Problem…", onClick: () => openReportDialog() },
        { label: "Suggest an Idea", onClick: () => void openExternal(ideaUrl()) },
        { label: "Issue Tracker", onClick: () => void openExternal(ISSUES_URL) },
        { separator: true, label: "" },
        { label: "Check for Updates…", onClick: () => void checkForUpdates(true, beforeUpdate(e)) },
        { label: `About ${PRODUCT_NAME}`, onClick: () => void showAbout() },
      ],
    },
  ] as MenuDef[]).filter((m) => m.items.length > 0);
}
