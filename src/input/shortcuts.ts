// Single source of truth for shortcuts: keymap.ts dispatches from this table, commands.ts reads its hints and
// the `?` HUD renders it, so they cannot disagree.

import { useDialogStore } from "../stores/dialogs";
import { readSetting } from "../ui/storedSetting";
import { DEFAULT_BINDINGS, bindingRows, pointerBindings } from "../viewport/navigator/bindings";

export interface Shortcut {
  key: string; // normalized lowercase key ("b", "home", "f6", "?")
  shift?: boolean;
  /** Ctrl (or Cmd) must be held. Only the booleans use it: U, B and I are taken, and the three want keys that
   *  read as a family. Everything else is bare so tool keys work one-handed beside the mouse. */
  ctrl?: boolean;
  action: string; // action id fed to main's handleAction (or a special-cased id)
  context: "model" | "sketch" | "global";
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  { key: "s", action: "sketch", context: "model", label: "Sketch" },
  { key: "e", action: "extrude", context: "model", label: "Extrude" },
  { key: "q", action: "presspull", context: "model", label: "Press/Pull" },
  { key: "f", action: "fillet", context: "model", label: "Fillet" },
  { key: "b", action: "chamfer", context: "model", label: "Chamfer (bevel)" },
  { key: "m", action: "move", context: "model", label: "Move" },
  { key: "i", action: "measure", context: "model", label: "Measure" },
  { key: "k", action: "split", context: "model", label: "Split Body" },
  { key: "u", ctrl: true, action: "boolean-union", context: "model", label: "Union" },
  { key: "b", ctrl: true, action: "boolean-subtract", context: "model", label: "Subtract" },
  { key: "i", ctrl: true, action: "boolean-intersect", context: "model", label: "Intersect" },
  { key: "u", action: "clean-up", context: "model", label: "Clean Up" },
  { key: "o", action: "offset-plane", context: "model", label: "Offset Plane" },
  { key: "h", action: "hide-selected", context: "model", label: "Hide selected bodies" },
  { key: "h", shift: true, action: "show-all-bodies", context: "model", label: "Show all bodies" },
  { key: "1", action: "selmode-faces", context: "model", label: "Select faces" },
  { key: "3", action: "selmode-auto", context: "model", label: "Select a body, then its faces" },
  { key: "2", action: "selmode-bodies", context: "model", label: "Select bodies" },
  { key: "x", action: "toggle-xray", context: "model", label: "See through (select what is behind)" },
  { key: "x", shift: true, action: "toggle-wireframe", context: "model", label: "Wireframe (edges only)" },
  { key: "l", action: "line", context: "sketch", label: "Line" },
  { key: "c", action: "circle", context: "sketch", label: "Circle" },
  { key: "r", action: "rectangle", context: "sketch", label: "Rectangle" },
  { key: "a", action: "arc", context: "sketch", label: "Arc" },
  { key: "d", action: "dimension", context: "sketch", label: "Dimension" },
  { key: "t", action: "trim", context: "sketch", label: "Trim" },
  { key: "o", action: "offset", context: "sketch", label: "Offset" },
  { key: "f", action: "fillet-sketch", context: "sketch", label: "Sketch Fillet" },
  { key: "p", action: "project", context: "sketch", label: "Project" },
  { key: "m", action: "move-sketch", context: "sketch", label: "Move/Rotate" },
  // Finish and go: E/Q in a sketch commit it and start the 3D tool (handleAction finishes the sketch first).
  { key: "e", action: "extrude", context: "sketch", label: "Finish & Extrude" },
  { key: "q", action: "presspull", context: "sketch", label: "Finish & Press/Pull" },
  // With a fitting selection these apply at once, otherwise they arm the tool.
  { key: "h", action: "horizontal", context: "sketch", label: "Horizontal" },
  { key: "v", action: "vertical", context: "sketch", label: "Vertical" },
  { key: "i", action: "coincident", context: "sketch", label: "Coincident or on curve" },
  { key: "g", action: "tangent", context: "sketch", label: "Tangent" },
  { key: "n", action: "perpendicular", context: "sketch", label: "Perpendicular" },
  { key: "p", shift: true, action: "parallel", context: "sketch", label: "Parallel" },
  { key: "e", shift: true, action: "equal", context: "sketch", label: "Equal" },
  { key: "l", shift: true, action: "collinear", context: "sketch", label: "Collinear" },
  { key: "c", shift: true, action: "concentric", context: "sketch", label: "Concentric" },
  { key: "m", shift: true, action: "midpoint", context: "sketch", label: "Midpoint" },
  { key: "s", shift: true, action: "symmetric", context: "sketch", label: "Symmetric" },
  { key: "f", shift: true, action: "fix", context: "sketch", label: "Fix" },
  // sketch-start conveniences from model mode (L/C/R/A/P start a sketch with that tool)
  { key: "l", action: "line", context: "model", label: "Sketch: Line" },
  { key: "c", action: "circle", context: "model", label: "Sketch: Circle" },
  { key: "r", action: "rectangle", context: "model", label: "Sketch: Rectangle" },
  { key: "a", action: "arc", context: "model", label: "Sketch: Arc" },
  { key: "p", action: "project", context: "model", label: "Sketch: Project" },
  { key: "home", action: "fit", context: "global", label: "Fit view" },
  { key: "home", shift: true, action: "reset-camera", context: "global", label: "Reset camera" },
  { key: "f6", action: "fit", context: "global", label: "Fit view" },
  { key: "arrowleft", action: "view-step-left", context: "global", label: "Turn the view left 15°" },
  { key: "arrowright", action: "view-step-right", context: "global", label: "Turn the view right 15°" },
  { key: "arrowup", action: "view-step-up", context: "global", label: "Tilt the view up 15°" },
  { key: "arrowdown", action: "view-step-down", context: "global", label: "Tilt the view down 15°" },
  { key: "arrowleft", shift: true, action: "view-step-left-fine", context: "global", label: "Turn the view left 5°" },
  {
    key: "arrowright",
    shift: true,
    action: "view-step-right-fine",
    context: "global",
    label: "Turn the view right 5°",
  },
  { key: "arrowup", shift: true, action: "view-step-up-fine", context: "global", label: "Tilt the view up 5°" },
  { key: "arrowdown", shift: true, action: "view-step-down-fine", context: "global", label: "Tilt the view down 5°" },
  { key: "?", action: "shortcut-help", context: "global", label: "Shortcut help" },
  { key: "z", action: "viewmode-cycle", context: "global", label: "Next view mode" },
  { key: "z", shift: true, action: "viewmode-cycle-back", context: "global", label: "Previous view mode" },
  {
    key: "v",
    shift: true,
    action: "clean-view",
    context: "global",
    label: "Clean view (hide every overlay, again to bring them back)",
  },
];

/** How a shortcut is written for a human ("Shift+H", "Ctrl+U", "Home"), shared by keyHint and the `?` HUD so
 *  the cheat sheet cannot advertise a key nothing binds. */
export function formatShortcut(s: Shortcut): string {
  const name = s.key === " " ? "space" : s.key.replace(/^arrow/, "");
  const k = name.length === 1 ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1);
  return `${s.ctrl ? "Ctrl+" : ""}${s.shift ? "Shift+" : ""}${k}`;
}

/** first key hint for an action ("Shift+H", "Ctrl+U", "Home"), for menus/palette. */
export function keyHint(action: string): string | undefined {
  const s = activeShortcuts().find((x) => x.action === action);
  return s ? formatShortcut(s) : undefined;
}

/** Resolve a keydown to an action for the current context (sketch keys are preferred
 *  while sketching; model keys otherwise; global always). */
export function resolveShortcut(key: string, shift: boolean, context: "model" | "sketch", ctrl = false): string | null {
  const k = key.toLowerCase();
  for (const s of activeShortcuts()) {
    // Every flag is compared, absent ones too: bare B (Chamfer) and Ctrl+B (Subtract) are different commands.
    if (s.key !== k || !!s.shift !== shift || !!s.ctrl !== ctrl) continue;
    if (s.context === "global" || s.context === context) return s.action;
  }
  return null;
}

// Overrides: a plugin holding input.remap may move a key.

/** A key for an action. An action the table has keeps its context and label; a
 *  contributed action needs a context (global if left out) and a label. An
 *  empty key unbinds it. */
export interface ShortcutOverride {
  action: string;
  key: string;
  shift?: boolean;
  ctrl?: boolean;
  /** Only to be refused: keymap.ts reads no Alt, and tools read Alt+key. */
  alt?: boolean;
  context?: Shortcut["context"];
  label?: string;
}

export type ShortcutProblem = { conflict: Shortcut } | { reserved: string } | { refused: string };

/** Combos handled before the table is asked (keymap.ts, app/keyboard.ts,
 *  app/engine.ts), written as formatShortcut writes them. */
const RESERVED: Record<string, string> = {
  "Ctrl+Z": "Undo",
  "Ctrl+Shift+Z": "Redo",
  "Ctrl+Y": "Redo",
  "Ctrl+S": "Save",
  "Ctrl+Shift+S": "Save As",
  "Ctrl+N": "New",
  "Ctrl+O": "Open",
  "Ctrl+E": "Export",
  "Ctrl+F": "Find",
  "Ctrl+K": "Command palette",
  "Ctrl+,": "Preferences",
  Escape: "Cancel",
  Tab: "Box select filter",
  Delete: "Delete",
  Backspace: "Delete",
  "?": "This sheet",
};

/** A table row with the identity a person's own key is stored against: action, context and the key it ships with. */
export interface ShortcutRow extends Shortcut {
  id: string;
}

/** A key a person chose for one row. An empty key unbinds the row. */
export interface UserShortcut {
  id: string;
  key: string;
  shift?: boolean;
  ctrl?: boolean;
}

const USER_KEY = "fundacad.keymap";

let overrides: ShortcutOverride[] = [];
let userOverrides: UserShortcut[] = readUserShortcuts();
let active: ShortcutRow[] | null = null;
const listeners = new Set<() => void>();

function readUserShortcuts(): UserShortcut[] {
  try {
    const v: unknown = JSON.parse(readSetting(USER_KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.flatMap((u: Partial<UserShortcut>) =>
      u && typeof u.id === "string" && typeof u.key === "string"
        ? [{ id: u.id, key: u.key, ...(u.shift ? { shift: true } : {}), ...(u.ctrl ? { ctrl: true } : {}) }]
        : [],
    );
  } catch {
    return [];
  }
}

function userChanged() {
  active = null;
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(userOverrides));
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn();
}

/** Called after the table moves, whoever moved it: a person or a plugin's keymap. */
export function onShortcutsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const sameCombo = (a: Pick<Shortcut, "key" | "shift" | "ctrl">, b: Pick<Shortcut, "key" | "shift" | "ctrl">) =>
  a.key === b.key && !!a.shift === !!b.shift && !!a.ctrl === !!b.ctrl;
const combo = (o: { key: string; shift?: boolean; ctrl?: boolean }): Pick<Shortcut, "key" | "shift" | "ctrl"> => ({
  key: o.key.toLowerCase(),
  ...(o.shift ? { shift: true } : {}),
  ...(o.ctrl ? { ctrl: true } : {}),
});
const overlap = (a: Shortcut["context"], b: Shortcut["context"]) => a === b || a === "global" || b === "global";
const idOf = (s: Shortcut, key = s.key ? formatShortcut(s) : "") => `${s.action}|${s.context}|${key}`;

/** The table with the plugin's keymap applied and the user's keys not yet. */
function staged(): ShortcutRow[] {
  const base: ShortcutRow[] = SHORTCUTS.map((s) => ({ ...s, id: idOf(s) }));
  const moved = new Map(overrides.map((o) => [o.action, o]));
  const mine: ShortcutRow[] = [];
  for (const o of overrides) {
    if (!o.key) continue;
    const rows = base.filter((s) => s.action === o.action);
    const from: ShortcutRow[] = rows.length
      ? rows
      : [
          {
            action: o.action,
            context: o.context ?? "global",
            label: o.label ?? o.action,
            key: "",
            id: idOf({ action: o.action, context: o.context ?? "global" } as Shortcut, ""),
          },
        ];
    for (const r of from) {
      const { shift: _s, ctrl: _c, ...rest } = r;
      mine.push({ ...rest, ...combo(o), context: o.context ?? r.context });
    }
  }
  return [...mine, ...base.filter((s) => !moved.has(s.action))];
}

/** Every row, an unbound one with an empty key. */
export function shortcutRows(): ShortcutRow[] {
  const mine = new Map(userOverrides.map((u) => [u.id, u]));
  return staged().map((r): ShortcutRow => {
    const u = mine.get(r.id);
    if (!u) return r;
    const { shift: _s, ctrl: _c, ...rest } = r;
    return { ...rest, ...combo(u) };
  });
}

/** The table with the overrides applied, changed rows first so a key a person or plugin chose is preferred over the
 *  table's own use of it. */
export function activeShortcuts(): ShortcutRow[] {
  if (active) return active;
  const mine = new Set(userOverrides.map((u) => u.id));
  const rows = shortcutRows().filter((r) => r.key);
  return (active = [...rows.filter((r) => mine.has(r.id)), ...rows.filter((r) => !mine.has(r.id))]);
}

export function shortcutOverridden(action: string): boolean {
  return overrides.some((o) => o.action === action);
}

/** Why a key cannot go to an action, or null when it can. */
export function checkShortcut(o: ShortcutOverride, table: Shortcut[] = activeShortcuts()): ShortcutProblem | null {
  if (o.alt) return { refused: "Alt is read by the tools, pick a key without it" };
  if (!o.key) return null;
  const row = combo(o);
  const name = formatShortcut({ ...row, action: o.action, context: "global", label: "" });
  if (RESERVED[name]) return { reserved: RESERVED[name]! };
  const ctx = o.context ?? SHORTCUTS.find((s) => s.action === o.action)?.context ?? "global";
  const hit = table.find((s) => s.action !== o.action && sameCombo(s, row) && overlap(s.context, ctx));
  return hit ? { conflict: hit } : null;
}

/** Sentences for what is wrong with a set of overrides, by action. */
export function describeShortcutProblem(p: ShortcutProblem): string {
  if ("conflict" in p) return `${formatShortcut(p.conflict)} is already used by ${p.conflict.label}`;
  if ("reserved" in p) return `taken by ${p.reserved}`;
  return p.refused;
}

/** Replace every override. Reserved and refused ones are left out; the rest
 *  apply, and the conflicts among them are returned and shown on the sheet. */
export function setShortcutOverrides(
  list: readonly ShortcutOverride[],
): { action: string; problem: ShortcutProblem }[] {
  const out: { action: string; problem: ShortcutProblem }[] = [];
  const kept: ShortcutOverride[] = [];
  for (const o of list) {
    const p = checkShortcut(o, SHORTCUTS);
    if (p && !("conflict" in p)) out.push({ action: o.action, problem: p });
    else kept.push(o);
  }
  overrides = kept;
  active = null;
  for (const o of kept) {
    const table = activeShortcuts().filter((s) => !(s.action === o.action && sameCombo(s, combo(o))));
    const p = checkShortcut(o, table);
    if (p) out.push({ action: o.action, problem: p });
  }
  for (const fn of listeners) fn();
  return out;
}

/** Why a key cannot go to one row, or null when it can. */
export function checkRow(
  id: string,
  c: { key: string; shift?: boolean; ctrl?: boolean; alt?: boolean },
): ShortcutProblem | null {
  if (c.alt) return { refused: "Alt is read by the tools, pick a key without it" };
  const row = combo(c);
  const name = formatShortcut({ ...row, action: "", context: "global", label: "" });
  if (RESERVED[name]) return { reserved: RESERVED[name]! };
  const ctx = shortcutRows().find((r) => r.id === id)?.context ?? "global";
  const hit = activeShortcuts().find((s) => s.id !== id && sameCombo(s, row) && overlap(s.context, ctx));
  return hit ? { conflict: hit } : null;
}

/** Give one row a key. A conflict is returned and nothing changes, unless `replace` is set, which unbinds the row that
 *  held the key. Null when the key was taken. */
export function setUserShortcut(
  id: string,
  c: { key: string; shift?: boolean; ctrl?: boolean; alt?: boolean },
  replace = false,
): ShortcutProblem | null {
  const problem = checkRow(id, c);
  if (problem && !(replace && "conflict" in problem)) return problem;
  const next = userOverrides.filter((u) => u.id !== id);
  const shipped = staged().find((r) => r.id === id);
  if (!shipped || !sameCombo(shipped, combo(c))) next.push({ id, ...combo(c) });
  if (problem && "conflict" in problem) {
    const other = (problem.conflict as ShortcutRow).id;
    userOverrides = [...next.filter((u) => u.id !== other), { id: other, key: "" }];
  } else {
    userOverrides = next;
  }
  userChanged();
  return null;
}

export function resetUserShortcuts(ids?: readonly string[]) {
  const before = userOverrides.length;
  userOverrides = ids ? userOverrides.filter((u) => !ids.includes(u.id)) : [];
  if (userOverrides.length !== before) userChanged();
}

export function userShortcutIds(): string[] {
  return userOverrides.map((u) => u.id);
}

/** Every pair of rows that answer the same key in the same context. */
export function shortcutConflicts(): [Shortcut, Shortcut][] {
  const t = activeShortcuts();
  const out: [Shortcut, Shortcut][] = [];
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      const a = t[i]!,
        b = t[j]!;
      if (a.action !== b.action && sameCombo(a, b) && overlap(a.context, b.context)) out.push([a, b]);
    }
  }
  return out;
}

// The shortcuts dialog's content, generated from the table so it cannot drift from the dispatcher.

/** One section of the dialog, derived from SHORTCUTS so it cannot drift from the dispatcher. A row with an `id` can be
 *  changed; one without is fixed. */
export interface HudGroup {
  name: string;
  rows: { key: string; label: string; changed?: boolean; id?: string }[];
}

const CONTEXTS = [
  ["Model", "model"],
  ["Sketch", "sketch"],
  ["Global", "global"],
] as const;

/** The editable rows of some actions, by context. Empty contexts are left out. */
export function shortcutGroupsOf(actions: ReadonlySet<string>): HudGroup[] {
  return contextGroups((s) => actions.has(s.action), false).filter((g) => g.rows.length);
}

function contextGroups(keep: (s: Shortcut) => boolean, core: boolean): HudGroup[] {
  const mine = new Set(userOverrides.map((u) => u.id));
  const fixed = new Set(Object.keys(RESERVED));
  const shipped = new Set(SHORTCUTS.map((s) => s.action));
  const order = new Map(SHORTCUTS.map((s, i) => [idOf(s), i]));
  return CONTEXTS.map(([name, ctx]) => ({
    name,
    rows: shortcutRows()
      .filter((s) => s.context === ctx && keep(s))
      .sort((a, b) => (order.get(a.id) ?? SHORTCUTS.length) - (order.get(b.id) ?? SHORTCUTS.length))
      .map((s) => {
        const user = mine.has(s.id);
        const changed = user || (core && shipped.has(s.action) && shortcutOverridden(s.action));
        return {
          key: s.key ? formatShortcut(s) : "",
          label: s.label,
          ...(changed ? { changed: true } : {}),
          ...(fixed.has(formatShortcut(s)) ? {} : { id: s.id }),
        };
      }),
  }));
}

/** Pure: the dialog's General content. Exported so it is unit-testable without a DOM. `skip` leaves out actions another
 *  page shows. */
export function shortcutHudGroups(skip: ReadonlySet<string> = new Set()): HudGroup[] {
  const fmt = formatShortcut;
  const clashes = shortcutConflicts().map(([a, b]) => ({
    key: fmt(a),
    label: `${a.label} and ${b.label} share this key, ${a.label} applies`,
  }));
  const custom = pointerBindings() !== DEFAULT_BINDINGS;
  return [
    ...(clashes.length ? [{ name: "Conflicts", rows: clashes }] : []),
    ...contextGroups((s) => !skip.has(s.action), true),
    {
      name: "Mouse",
      rows: [
        ...bindingRows(pointerBindings()).map((r) => (custom ? { ...r, changed: true } : r)),
        { key: "Wheel", label: "Zoom" },
        { key: "Left drag", label: "Box select (see Always, below)" },
        { key: "Left click", label: "Select a body, then a face on it (pause over it to light the face up first)" },
      ],
    },
    {
      name: "Always",
      rows: [
        { key: "Ctrl+K", label: "Command palette" },
        { key: "Ctrl+Z / Ctrl+Y", label: "Undo / Redo" },
        { key: "Ctrl+S / Ctrl+Shift+S", label: "Save / Save As" },
        { key: "Ctrl+N / Ctrl+O / Ctrl+E", label: "New / Open / Export" },
        { key: "Del", label: "Delete face (heal) / feature" },
        { key: "Esc", label: "Cancel / clear selection" },
        // A gesture, not a key, listed here because this is where anyone would look. "right"/"left" name the
        // drag direction; all are left-button drags.
        {
          key: "Drag",
          label:
            "Box select: dragging to the right takes what is fully inside, dragging to the left takes what it touches",
        },
        { key: "Shift+Drag", label: "Box select, adding to what is selected" },
        { key: "Tab", label: "While boxing: take everything / faces / sketch profiles / edges / bodies" },
      ],
    },
  ];
}

/** Toggle the shortcuts dialog, a facade over stores/dialogs.ts rendered by components/overlays/ShortcutsDialog.vue. */
export function toggleShortcutHUD() {
  const dialogs = useDialogStore();
  dialogs.shortcuts = !dialogs.shortcuts;
}
