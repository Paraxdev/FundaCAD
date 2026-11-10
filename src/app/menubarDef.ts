import { exportSelection, importModel } from "../io/files";
import { saveWork, saveWorkAs } from "./documentActions";
import { contributedMenus } from "../plugins/contrib";
import { toggleShortcutHUD } from "../input/shortcuts";
import { checkForUpdates, showAbout } from "../ui/updates";
import { useDialogStore } from "../stores/dialogs";
import { setWorkspace } from "../ui/workspace";
import { ACCESSIBILITY_PAGE, MANUAL_URL, openExternal } from "../ui/welcome";
import { openReportDialog } from "../ui/bugReporter";
import { ideaUrl, REPO_URL } from "../ui/reportText";
import { menuName, type MenuDef, type MenuItem } from "../ui/menu";
import { beforeUpdate } from "./unsavedGuard";
import { PRODUCT_NAME } from "./channel";
import { t } from "../i18n";
import { allCommands, commandEnglish, commandLabel, GEOMETRY_COMMANDS, type Command } from "../ui/commands";
import { analysisFlags } from "../ui/railActive";
import { canStep, stepLabelFor, stepMenuText } from "../ui/canStep";
import type { Engine } from "./engine";
import { deleteRows, pickedFeatureIds, toggleSuppressRows } from "./featureRows";

const ISSUES_URL = `${REPO_URL}/issues`;

/** A contribution naming an existing menu appends to it, otherwise it creates one before `before`. Copies the item
 *  arrays, which are the plugin's own and would grow once per render if pushed into. */
function withContributions(menus: MenuDef[]): MenuDef[] {
  const out = menus.map((m) => ({ ...m, items: [...m.items] }));
  for (const c of contributedMenus()) {
    const existing = out.find((m) => menuName(m) === c.menu);
    if (existing) {
      existing.items.push(...c.items);
      continue;
    }
    const at = c.before ? out.findIndex((m) => menuName(m) === c.before) : -1;
    const fresh: MenuDef = { label: c.menu, items: [...c.items] };
    if (at >= 0) out.splice(at, 0, fresh);
    else out.push(fresh);
  }
  return out;
}

const ANALYSIS_ITEMS = [
  { id: "draft-analysis", label: () => t("menu.view.overhang"), refName: "Overhang" },
  { id: "zebra", label: () => t("menu.view.zebra"), refName: "Zebra" },
  { id: "curvature", label: () => t("menu.view.curvature"), refName: "Curvature" },
  { id: "component-colors", label: () => t("menu.view.bodyColors"), refName: "Body Colors" },
];

// The label is read through commandLabel, since an allCommands() copy holds a getter frozen at its language.
const commandRow = (e: Engine) => (c: Command): MenuItem => ({
  label: () => commandLabel(c.id),
  ...(commandEnglish(c.id) !== undefined ? { refName: commandEnglish(c.id)! } : {}),
  ...(c.key ? { shortcut: c.key } : {}),
  onClick: () => e.handleAction(c.id),
});

function viewItems(e: Engine): MenuDef["items"] {
  const view = allCommands()
    .filter((c) => c.group === "View")
    .map(commandRow(e));
  const analysis = ANALYSIS_ITEMS.map((a) => ({
    label: a.label,
    refName: a.refName,
    checked: () => analysisFlags(e.viewport)[a.id] === true,
    onClick: () => e.handleAction(a.id),
  }));
  return [...view, { separator: true, label: "" }, ...analysis];
}

// Left enabled in a sketch: refusing in words says why, a greyed item says nothing.
function geometryItems(e: Engine): MenuDef["items"] {
  const all = allCommands();
  return [...GEOMETRY_COMMANDS].map((id) => all.find((c) => c.id === id)!).map(commandRow(e));
}

/** `disabled` and `checked` are thunks, re-evaluated every time a menu opens. */
export function buildMenubar(e: Engine): MenuDef[] {
  return withContributions([
    {
      label: () => t("menu.file"),
      refName: "File",
      items: [
        { label: () => t("menu.file.home"), refName: "Home", onClick: () => e.ui.home.open() },
        { separator: true, label: "" },
        { label: () => t("menu.file.new"), refName: "New", shortcut: "Ctrl+N", onClick: () => void e.newDocument() },
        { label: () => t("menu.file.open"), refName: "Open…", shortcut: "Ctrl+O", onClick: () => void e.openDoc() },
        { separator: true, label: "" },
        {
          label: () => t("menu.file.importMesh"),
          refName: "Import Mesh…",
          onClick: () => void importModel(e.store, e.geometry),
        },
        { separator: true, label: "" },
        { label: () => t("menu.file.save"), refName: "Save", shortcut: "Ctrl+S", onClick: () => void saveWork(e) },
        {
          label: () => t("menu.file.saveAs"),
          refName: "Save As…",
          shortcut: "Ctrl+Shift+S",
          onClick: () => void saveWorkAs(e),
        },
        { separator: true, label: "" },
        {
          label: () => t("menu.file.export"),
          refName: "Export…",
          shortcut: "Ctrl+E",
          onClick: () => void exportSelection(e.store, e.geometry, e.viewport),
        },
      ],
    },
    {
      label: () => t("menu.edit"),
      refName: "Edit",
      items: [
        {
          label: () => stepMenuText("undo", stepLabelFor(e, "undo")),
          refName: "Undo",
          shortcut: "Ctrl+Z",
          disabled: () => !canStep(e, "undo"),
          onClick: () => e.doUndo(),
        },
        {
          label: () => stepMenuText("redo", stepLabelFor(e, "redo")),
          refName: "Redo",
          shortcut: "Ctrl+Y",
          disabled: () => !canStep(e, "redo"),
          onClick: () => e.doRedo(),
        },
        { separator: true, label: "" },
        {
          label: () => t("menu.edit.delete"),
          refName: "Delete",
          shortcut: "Del",
          // A selected face is deletable too. getSelectedFaceIds, since selectedFacesForPressPull walks every triangle.
          disabled: () => !e.selectedFeature && e.viewport.getSelectedFaceIds().length === 0,
          onClick: () => {
            if (e.deleteSelectedFace()) return;
            if (e.selectedFeature) deleteRows(e, pickedFeatureIds(e));
          },
        },
        {
          label: () => t("menu.edit.suppress"),
          refName: "Suppress / Unsuppress",
          disabled: () => !e.selectedFeature,
          onClick: () => e.selectedFeature && toggleSuppressRows(e.store, pickedFeatureIds(e)),
        },
        { separator: true, label: "" },
        // No ellipsis: it opens a workspace, not a window.
        { label: () => t("menu.edit.materials"), refName: "Materials", onClick: () => setWorkspace("render") },
        // Before the geometry rows, so it stays in view when a short window scrolls the menu: it holds Accessibility.
        {
          label: () => t("menu.edit.preferences"),
          refName: "Preferences…",
          shortcut: "Ctrl+,",
          onClick: () => {
            useDialogStore().openPreferences();
          },
        },
        { separator: true, label: "" },
        ...geometryItems(e),
      ],
    },
    { label: () => t("menu.view"), refName: "View", items: viewItems(e) },
    {
      label: () => t("menu.help"),
      refName: "Help",
      items: [
        {
          label: () => t("menu.help.shortcuts"),
          refName: "Keyboard Shortcuts",
          shortcut: "?",
          onClick: () => toggleShortcutHUD(),
        },
        { label: () => t("menu.help.manual"), refName: "Manual", onClick: () => void openExternal(MANUAL_URL) },
        {
          label: () => t("menu.help.accessibility"),
          refName: "Accessibility",
          onClick: () => void openExternal(ACCESSIBILITY_PAGE),
        },
        { separator: true, label: "" },
        { label: () => t("menu.help.reportProblem"), refName: "Report a Problem…", onClick: () => openReportDialog() },
        {
          label: () => t("menu.help.suggestIdea"),
          refName: "Suggest an Idea",
          onClick: () => void openExternal(ideaUrl()),
        },
        {
          label: () => t("menu.help.issueTracker"),
          refName: "Issue Tracker",
          onClick: () => void openExternal(ISSUES_URL),
        },
        { separator: true, label: "" },
        {
          label: () => t("menu.help.checkUpdates"),
          refName: "Check for Updates…",
          onClick: () => void checkForUpdates(true, beforeUpdate(e)),
        },
        {
          label: () => t("menu.help.about", { name: PRODUCT_NAME }),
          refName: `About ${PRODUCT_NAME}`,
          onClick: () => void showAbout(),
        },
      ],
    },
  ] as MenuDef[]).filter((m) => m.items.length > 0);
}
