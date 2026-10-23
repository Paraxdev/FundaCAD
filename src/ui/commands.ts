// The command palette registry: the ribbon's tool groups plus File and View commands. Key hints come from
// src/input/shortcuts.ts so the palette cannot advertise a key the keymap does not bind.

import { modelGroups, SKETCH, leavesOf, type Group } from "./ribbonDefs";
import { keyHint } from "../input/shortcuts";

export interface Command {
  id: string; // the action id passed to the central dispatcher (handleAction)
  label: string;
  group: string; // shown as a subtle category in the palette
  context: "model" | "sketch" | "global";
  key?: string; // display hint
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
  { id: "fit", label: "Fit View", group: "View", context: "global", key: "Home / F6" },
  { id: "reset-camera", label: "Reset Camera", group: "View", context: "global", key: "Shift+Home" },
  { id: "iso", label: "Isometric View", group: "View", context: "global" },
  { id: "top", label: "Top View", group: "View", context: "global" },
  { id: "front", label: "Front View", group: "View", context: "global" },
  { id: "right", label: "Right View", group: "View", context: "global" },
  { id: "persp", label: "Cycle Projection (Persp / Ortho / Auto)", group: "View", context: "global" },
  { id: "selmode", label: "Toggle Faces / Bodies selection", group: "View", context: "global" },
  { id: "viewmode-matcap", label: "Matcap View Mode", group: "View", context: "global" },
  { id: "viewmode-realtime", label: "Realtime View Mode", group: "View", context: "global" },
  { id: "viewmode-pathtraced", label: "Path Traced View Mode", group: "View", context: "global" },
  { id: "viewmode-cycle", label: "Next View Mode", group: "View", context: "global", key: "Z" },
  { id: "show-all-bodies", label: "Show All Bodies", group: "View", context: "global", key: "Shift+H" },
  { id: "shortcut-help", label: "Keyboard Shortcuts…", group: "Help", context: "global", key: "?" },
  { id: "manual", label: "Manual", group: "Help", context: "global" },
  { id: "report-problem", label: "Report a Problem…", group: "Help", context: "global" },
  { id: "suggest-idea", label: "Suggest an Idea", group: "Help", context: "global" },
  // Pinned ribbon groups (FINISH, PALETTE) live outside SKETCH, so the palette lists them explicitly.
  { id: "finish", label: "Finish Sketch", group: "SKETCH", context: "sketch" },
  { id: "palette", label: "Sketch Palette", group: "SKETCH", context: "sketch" },
];

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
  return [...fromGroups(modelGroups(), "model"), ...fromGroups(SKETCH, "sketch"), ...GLOBAL];
}
