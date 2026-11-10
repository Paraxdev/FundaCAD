// The command palette registry: the ribbon's tool groups plus File and View commands. Key hints come from
// src/input/shortcuts.ts so the palette cannot advertise a key the keymap does not bind.

import { modelGroups, SKETCH, leavesOf, type Group } from "./ribbonDefs";
import { keyHint, STANDARD_VIEWS } from "../input/shortcuts";
import { t } from "../i18n";

export interface Command {
  id: string; // the action id passed to the central dispatcher (handleAction)
  label: string;
  group: string; // shown as a subtle category in the palette
  context: "model" | "sketch" | "global";
  key?: string; // display hint
}

// A getter, so the label follows a change of language.
function viewCommand(id: string): Command {
  return {
    id,
    group: "View",
    context: "global",
    get label() {
      return t("view.command", { view: id });
    },
  };
}

// Only commands with no ribbon button, or they show twice in the palette. ribbonDefs.test.ts enforces it.
const GLOBAL: Command[] = [
  { id: "welcome", label: "Home", group: "File", context: "global" },
  { id: "new", label: "New", group: "File", context: "global", key: "Ctrl+N" },
  { id: "open", label: "Open…", group: "File", context: "global", key: "Ctrl+O" },
  { id: "save", label: "Save", group: "File", context: "global", key: "Ctrl+S" },
  { id: "saveas", label: "Save As…", group: "File", context: "global", key: "Ctrl+Shift+S" },
  { id: "export", label: "Export…", group: "File", context: "global", key: "Ctrl+E" },
  { id: "undo", label: "Undo", group: "Edit", context: "global", key: "Ctrl+Z" },
  { id: "redo", label: "Redo", group: "Edit", context: "global", key: "Ctrl+Y" },
  { id: "fit", label: "Fit View", group: "View", context: "global", key: "Home" },
  { id: "reset-camera", label: "Reset Camera", group: "View", context: "global", key: "Shift+Home" },
  ...STANDARD_VIEWS.map(viewCommand),
  { id: "persp", label: "Cycle Projection (Persp / Ortho / Auto)", group: "View", context: "global" },
  { id: "selmode", label: "Toggle Faces / Bodies selection", group: "View", context: "global" },
  { id: "viewmode-matcap", label: "Matcap View Mode", group: "View", context: "global" },
  { id: "viewmode-realtime", label: "Realtime View Mode", group: "View", context: "global" },
  { id: "viewmode-pathtraced", label: "Path Traced View Mode", group: "View", context: "global" },
  { id: "viewmode-cycle", label: "Next View Mode", group: "View", context: "global", key: "Z" },
  { id: "show-all-bodies", label: "Show All Bodies", group: "View", context: "global", key: "Shift+H" },
  { id: "show-console", label: "Show Console", group: "View", context: "global" },
  { id: "show-last-message", label: "Show Last Message", group: "View", context: "global" },
  { id: "describe-model", label: "Describe Model…", group: "View", context: "global" },
  { id: "describe-selection", label: "Describe Selection", group: "View", context: "global" },
  { id: "go-menubar", label: "Go to Menu Bar", group: "Go", context: "global" },
  { id: "go-tools", label: "Go to Tools", group: "Go", context: "global" },
  { id: "go-items", label: "Go to Items", group: "Go", context: "global" },
  { id: "go-model", label: "Go to Model", group: "Go", context: "global" },
  { id: "go-panels", label: "Go to Panels", group: "Go", context: "global" },
  { id: "go-history", label: "Go to History", group: "Go", context: "global" },
  { id: "browse-geometry", label: "Browse Faces and Edges", group: "Go", context: "global" },
  { id: "next-face", label: "Next Face", group: "Edit", context: "global" },
  { id: "previous-face", label: "Previous Face", group: "Edit", context: "global" },
  { id: "next-edge", label: "Next Edge", group: "Edit", context: "global" },
  { id: "previous-edge", label: "Previous Edge", group: "Edit", context: "global" },
  { id: "preferences", label: "Preferences…", group: "Edit", context: "global", key: "Ctrl+," },
  { id: "accessibility-settings", label: "Accessibility Settings…", group: "Edit", context: "global" },
  { id: "interface-size-up", label: "Larger Interface", group: "View", context: "global", key: "Ctrl+Plus" },
  { id: "interface-size-down", label: "Smaller Interface", group: "View", context: "global", key: "Ctrl+Minus" },
  { id: "interface-size-reset", label: "Reset Interface Size", group: "View", context: "global", key: "Ctrl+0" },
  { id: "shortcut-help", label: "Keyboard Shortcuts…", group: "Help", context: "global", key: "?" },
  { id: "manual", label: "Manual", group: "Help", context: "global" },
  { id: "report-problem", label: "Report a Problem…", group: "Help", context: "global" },
  { id: "suggest-idea", label: "Suggest an Idea", group: "Help", context: "global" },
  // Pinned ribbon groups (FINISH, PALETTE) live outside SKETCH, so the palette lists them explicitly.
  { id: "finish", label: "Finish Sketch", group: "SKETCH", context: "sketch" },
  { id: "palette", label: "Sketch Palette", group: "SKETCH", context: "sketch" },
];

/** They ship without a key, so a hint is only ever a key the person chose. The Edit menu lists them too. */
export const GEOMETRY_COMMANDS: ReadonlySet<string> = new Set([
  "next-face",
  "previous-face",
  "next-edge",
  "previous-edge",
  "browse-geometry",
]);

/** Their hint comes from the shortcut table, so it is the key the person chose: the geometry commands ship without
 *  one, the views with Ctrl and a digit. */
const CHOSEN_KEY_COMMANDS: ReadonlySet<string> = new Set([
  ...GEOMETRY_COMMANDS,
  "describe-model",
  "describe-selection",
  "front",
  "back",
  "left",
  "right",
  "top",
  "bottom",
  "iso",
]);

function fromGroups(groups: Group[], context: "model" | "sketch"): Command[] {
  const out: Command[] = [];
  for (const g of groups) {
    for (const it of g.items) {
      // Flatten split buttons via leavesOf, or every tool in a dropdown is lost to the palette.
      for (const leaf of leavesOf(it)) {
        if (leaf.action === "palette" || leaf.kind === "toggle") continue; // not palette commands
        const key = keyHint(leaf.action) ?? leaf.key;
        out.push({
          id: leaf.action,
          label: leaf.label,
          group: g.label,
          context,
          ...(key !== undefined ? { key } : {}),
        });
      }
    }
  }
  return out;
}

export function allCommands(): Command[] {
  // modelGroups(), not MODEL: an action whose capability is off must not be reachable here either.
  return [
    ...fromGroups(modelGroups(), "model"),
    ...fromGroups(SKETCH, "sketch"),
    ...GLOBAL.map((c) => {
      if (!CHOSEN_KEY_COMMANDS.has(c.id)) return c;
      const key = keyHint(c.id);
      return key === undefined ? c : { ...c, key };
    }),
  ];
}
