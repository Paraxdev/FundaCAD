// The command palette registry: the ribbon's tool groups plus File and View commands. Key hints come from
// src/input/shortcuts.ts so the palette cannot advertise a key the keymap does not bind.

import { modelGroups, SKETCH, leavesOf, toolLabel, toolEnglish, groupShown, type Group } from "./ribbonDefs";
import { keyHint, STANDARD_VIEWS } from "../input/shortcuts";
import { t, tEnglish, type MessageKey } from "../i18n";

export interface Command {
  id: string; // the action id passed to the central dispatcher (handleAction)
  label: string;
  group: string; // shown as a subtle category in the palette
  context: "model" | "sketch" | "global";
  key?: string; // display hint
}

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

const LABEL_KEYS = new Map<string, MessageKey>();

// A getter, so the label follows a change of language; the key is kept for the English alias.
function cmd(
  id: string,
  group: string,
  labelKey: MessageKey,
  opts: { key?: string; context?: Command["context"] } = {},
): Command {
  LABEL_KEYS.set(id, labelKey);
  return {
    id,
    group,
    context: opts.context ?? "global",
    ...(opts.key !== undefined ? { key: opts.key } : {}),
    get label() {
      return t(labelKey);
    },
  };
}

// Only commands with no ribbon button, or they show twice in the palette. ribbonDefs.test.ts enforces it.
const GLOBAL: Command[] = [
  cmd("welcome", "File", "command.welcome"),
  cmd("new", "File", "command.new", { key: "Ctrl+N" }),
  cmd("open", "File", "command.open", { key: "Ctrl+O" }),
  cmd("save", "File", "command.save", { key: "Ctrl+S" }),
  cmd("saveas", "File", "command.saveAs", { key: "Ctrl+Shift+S" }),
  cmd("export", "File", "command.export", { key: "Ctrl+E" }),
  cmd("undo", "Edit", "command.undo", { key: "Ctrl+Z" }),
  cmd("redo", "Edit", "command.redo", { key: "Ctrl+Y" }),
  cmd("fit", "View", "command.fit", { key: "Home" }),
  cmd("reset-camera", "View", "command.resetCamera", { key: "Shift+Home" }),
  ...STANDARD_VIEWS.map(viewCommand),
  cmd("persp", "View", "command.persp"),
  cmd("selmode", "View", "command.selmode"),
  cmd("viewmode-matcap", "View", "command.viewmodeMatcap"),
  cmd("viewmode-realtime", "View", "command.viewmodeRealtime"),
  cmd("viewmode-pathtraced", "View", "command.viewmodePathtraced"),
  cmd("viewmode-cycle", "View", "command.viewmodeCycle", { key: "Z" }),
  cmd("show-all-bodies", "View", "command.showAllBodies", { key: "Shift+H" }),
  cmd("show-console", "View", "command.showConsole"),
  cmd("show-last-message", "View", "command.showLastMessage"),
  cmd("describe-model", "View", "command.describeModel"),
  cmd("describe-selection", "View", "command.describeSelection"),
  cmd("go-menubar", "Go", "command.goMenubar"),
  cmd("go-tools", "Go", "command.goTools"),
  cmd("go-items", "Go", "command.goItems"),
  cmd("go-model", "Go", "command.goModel"),
  cmd("go-panels", "Go", "command.goPanels"),
  cmd("go-history", "Go", "command.goHistory"),
  cmd("browse-geometry", "Go", "command.browseGeometry"),
  cmd("next-face", "Edit", "command.nextFace"),
  cmd("previous-face", "Edit", "command.previousFace"),
  cmd("next-edge", "Edit", "command.nextEdge"),
  cmd("previous-edge", "Edit", "command.previousEdge"),
  cmd("preferences", "Edit", "command.preferences", { key: "Ctrl+," }),
  cmd("accessibility-settings", "Edit", "command.accessibilitySettings"),
  cmd("interface-size-up", "View", "command.interfaceSizeUp", { key: "Ctrl+Plus" }),
  cmd("interface-size-down", "View", "command.interfaceSizeDown", { key: "Ctrl+Minus" }),
  cmd("interface-size-reset", "View", "command.interfaceSizeReset", { key: "Ctrl+0" }),
  cmd("shortcut-help", "Help", "command.shortcutHelp", { key: "?" }),
  cmd("manual", "Help", "command.manual"),
  cmd("report-problem", "Help", "command.reportProblem"),
  cmd("suggest-idea", "Help", "command.suggestIdea"),
  // Pinned ribbon groups (FINISH, PALETTE) live outside SKETCH, so the palette lists them explicitly.
  cmd("finish", "SKETCH", "command.finish", { context: "sketch" }),
  cmd("palette", "SKETCH", "command.palette", { context: "sketch" }),
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
          get label() {
            return leaf.label;
          },
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

/** The live label of a built in command, read at call time so a menu row follows the language. */
export function commandLabel(id: string): string {
  return GLOBAL.find((c) => c.id === id)?.label ?? toolLabel(id) ?? id;
}

/** The English label, the stable name a menu row is found by and a quiet alias in the palette. */
export function commandEnglish(id: string): string | undefined {
  const key = LABEL_KEYS.get(id);
  if (key) return tEnglish(key);
  if ((STANDARD_VIEWS as readonly string[]).includes(id)) return tEnglish("view.command", { view: id });
  return toolEnglish(id);
}

/** A group is an id; built in and ribbon groups have a display text, any other shows as it is. */
export function groupText(group: string): string {
  switch (group) {
    case "File":
      return t("palette.group.file");
    case "Edit":
      return t("palette.group.edit");
    case "View":
      return t("palette.group.view");
    case "Go":
      return t("palette.group.go");
    case "Help":
      return t("palette.group.help");
    case "SKETCH":
      return t("tool.sketch");
    default:
      return groupShown(group) ?? group;
  }
}
