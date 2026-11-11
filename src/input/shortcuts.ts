// Single source of truth for shortcuts: keymap.ts dispatches from this table, commands.ts reads its hints and
// the `?` HUD renders it, so they cannot disagree.

import { useDialogStore } from "../stores/dialogs";
import { singleKeysOn } from "../ui/a11yPrefs";
import { latinKey } from "./platform";
import { readSetting } from "../ui/storedSetting";
import { DEFAULT_BINDINGS, bindingRows, pointerBindings } from "../viewport/navigator/bindings";
import type { StandardView } from "../viewport/cameras";
import { t, type MessageArgs, type MessageKey } from "../i18n";

export interface Shortcut {
  key: string; // normalized lowercase key ("b", "home", "f6", "?")
  shift?: boolean;
  /** Ctrl (or Cmd) must be held. The booleans use it, since U, B and I are taken and the three want keys that read as
   *  a family, and the views, whose digits are the selection modes bare. Everything else is bare so tool keys work
   *  one-handed beside the mouse. */
  ctrl?: boolean;
  action: string; // action id fed to main's handleAction (or a special-cased id)
  context: "model" | "sketch" | "global";
  label: string;
}

/** The seven views in the order of their Ctrl digit. */
export const STANDARD_VIEWS: readonly StandardView[] = ["front", "back", "left", "right", "top", "bottom", "iso"];

/** `t` and `tEnglish` share this shape, so one say function gives the shown name and the English search alias. */
export type Translate = (key: MessageKey, args?: MessageArgs) => string;
type Say = (tr: Translate) => string;

// Spreading a row copies a getter's value, so labels shown from a copy are read again from here by action|context.
const SAY = new Map<string, Say>();
const sayKey = (action: string, context: string) => `${action}|${context}`;

interface Keys {
  shift?: boolean;
  ctrl?: boolean;
}

function row(key: string, action: string, context: Shortcut["context"], say: Say, mods: Keys = {}): Shortcut {
  SAY.set(sayKey(action, context), say);
  return {
    key,
    ...mods,
    action,
    context,
    get label() {
      return say(t);
    },
  };
}

/** The name of a row in the language of `tr`, whether the row is the table's own or a copy of it. */
export function shortcutLabel(s: Shortcut, tr: Translate = t): string {
  const say = SAY.get(sayKey(s.action, s.context));
  return say ? say(tr) : s.label;
}

const line =
  (key: MessageKey): Say =>
  (tr) =>
    tr(key);
const withTool =
  (key: MessageKey, tool: MessageKey): Say =>
  (tr) =>
    tr(key, { tool: tr(tool) });
const turn =
  (key: MessageKey, deg: number): Say =>
  (tr) =>
    tr(key, { deg });

const viewShortcut = (action: StandardView, key: string) =>
  row(key, action, "global", (tr) => tr("view.named", { view: action }), { ctrl: true });

export const SHORTCUTS: Shortcut[] = [
  row("s", "sketch", "model", line("tool.sketch")),
  row("e", "extrude", "model", line("tool.extrude")),
  row("q", "presspull", "model", line("tool.pressPull")),
  row("f", "fillet", "model", line("tool.fillet")),
  row("b", "chamfer", "model", line("shortcuts.action.chamfer")),
  row("m", "move", "model", line("tool.move")),
  row("i", "measure", "model", line("tool.measure")),
  row("k", "split", "model", line("tool.splitBody")),
  row("u", "boolean-union", "model", line("tool.union"), { ctrl: true }),
  row("b", "boolean-subtract", "model", line("tool.subtract"), { ctrl: true }),
  row("i", "boolean-intersect", "model", line("tool.intersect"), { ctrl: true }),
  row("u", "clean-up", "model", line("tool.cleanUp")),
  row("o", "offset-plane", "model", line("tool.offsetPlane")),
  row("h", "hide-selected", "model", line("shortcuts.action.hideSelected")),
  row("h", "show-all-bodies", "model", line("command.showAllBodies"), { shift: true }),
  row("1", "selmode-faces", "model", line("shortcuts.action.selectFaces")),
  row("3", "selmode-auto", "model", line("shortcuts.action.selectAuto")),
  row("2", "selmode-bodies", "model", line("shortcuts.action.selectBodies")),
  row("x", "toggle-xray", "model", line("shortcuts.action.xray")),
  row("x", "toggle-wireframe", "model", line("shortcuts.action.wireframe"), { shift: true }),
  row("l", "line", "sketch", line("tool.line")),
  row("c", "circle", "sketch", line("tool.circle")),
  row("r", "rectangle", "sketch", line("tool.rectangle")),
  row("a", "arc", "sketch", line("tool.arc")),
  row("d", "dimension", "sketch", line("tool.dimension")),
  row("t", "trim", "sketch", line("tool.trim")),
  row("o", "offset", "sketch", line("tool.offset")),
  row("f", "fillet-sketch", "sketch", line("shortcuts.action.sketchFillet")),
  row("p", "project", "sketch", line("tool.project")),
  row("m", "move-sketch", "sketch", line("tool.moveRotate")),
  // Finish and go: E/Q in a sketch commit it and start the 3D tool (handleAction finishes the sketch first).
  row("e", "extrude", "sketch", withTool("shortcuts.action.finishWith", "tool.extrude")),
  row("q", "presspull", "sketch", withTool("shortcuts.action.finishWith", "tool.pressPull")),
  // With a fitting selection these apply at once, otherwise they arm the tool.
  row("h", "horizontal", "sketch", line("tool.horizontal")),
  row("v", "vertical", "sketch", line("tool.vertical")),
  row("i", "coincident", "sketch", line("shortcuts.action.coincident")),
  row("g", "tangent", "sketch", line("tool.tangent")),
  row("n", "perpendicular", "sketch", line("shortcuts.action.perpendicular")),
  row("p", "parallel", "sketch", line("tool.parallel"), { shift: true }),
  row("e", "equal", "sketch", line("tool.equal"), { shift: true }),
  row("l", "collinear", "sketch", line("tool.collinear"), { shift: true }),
  row("c", "concentric", "sketch", line("tool.concentric"), { shift: true }),
  row("m", "midpoint", "sketch", line("tool.midpoint"), { shift: true }),
  row("s", "symmetric", "sketch", line("tool.symmetric"), { shift: true }),
  row("f", "fix", "sketch", line("tool.fix"), { shift: true }),
  // sketch-start conveniences from model mode (L/C/R/A/P start a sketch with that tool)
  row("l", "line", "model", withTool("shortcuts.action.sketchWith", "tool.line")),
  row("c", "circle", "model", withTool("shortcuts.action.sketchWith", "tool.circle")),
  row("r", "rectangle", "model", withTool("shortcuts.action.sketchWith", "tool.rectangle")),
  row("a", "arc", "model", withTool("shortcuts.action.sketchWith", "tool.arc")),
  row("p", "project", "model", withTool("shortcuts.action.sketchWith", "tool.project")),
  row("home", "fit", "global", line("command.fit")),
  row("home", "reset-camera", "global", line("command.resetCamera"), { shift: true }),
  ...STANDARD_VIEWS.map((view, i) => viewShortcut(view, String(i + 1))),
  row("f6", "region-next", "global", line("shortcuts.action.regionNext")),
  row("f6", "region-prev", "global", line("shortcuts.action.regionPrev"), { shift: true }),
  row("", "next-face", "global", line("command.nextFace")),
  row("", "previous-face", "global", line("command.previousFace")),
  row("", "next-edge", "global", line("command.nextEdge")),
  row("", "previous-edge", "global", line("command.previousEdge")),
  row("", "browse-geometry", "global", line("command.browseGeometry")),
  row("", "describe-model", "global", line("shortcuts.action.describeModel")),
  row("", "describe-selection", "global", line("shortcuts.action.describeSelection")),
  row("arrowleft", "view-step-left", "global", turn("shortcuts.action.turnLeft", 15)),
  row("arrowright", "view-step-right", "global", turn("shortcuts.action.turnRight", 15)),
  row("arrowup", "view-step-up", "global", turn("shortcuts.action.tiltUp", 15)),
  row("arrowdown", "view-step-down", "global", turn("shortcuts.action.tiltDown", 15)),
  row("arrowleft", "view-step-left-fine", "global", turn("shortcuts.action.turnLeft", 5), { shift: true }),
  row("arrowright", "view-step-right-fine", "global", turn("shortcuts.action.turnRight", 5), { shift: true }),
  row("arrowup", "view-step-up-fine", "global", turn("shortcuts.action.tiltUp", 5), { shift: true }),
  row("arrowdown", "view-step-down-fine", "global", turn("shortcuts.action.tiltDown", 5), { shift: true }),
  row("?", "shortcut-help", "global", line("shortcuts.action.help")),
  row("z", "viewmode-cycle", "global", line("command.viewmodeCycle")),
  row("z", "viewmode-cycle-back", "global", line("shortcuts.action.viewmodeBack"), { shift: true }),
  row("v", "clean-view", "global", line("shortcuts.action.cleanView"), { shift: true }),
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
  // Single key shortcuts off: a character key without Ctrl or Cmd, Shift held or not, binds nothing (WCAG 2.1.4).
  if (!ctrl && k.length === 1 && !singleKeysOn()) return null;
  for (const s of activeShortcuts()) {
    // Every flag is compared, absent ones too: bare B (Chamfer) and Ctrl+B (Subtract) are different commands.
    if (s.key !== k || !!s.shift !== shift || !!s.ctrl !== ctrl) continue;
    if (s.context === "global" || s.context === context) return s.action;
  }
  return null;
}

/** A running tool's own character key (Section's F, Pattern's ] or +) by latinKey, or "" for a named key, and with
 *  Single key shortcuts off unless Ctrl or Cmd is held. Each tool still applies its own modifier rule. */
export function toolChar(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  const k = latinKey(e);
  return k.length === 1 && (singleKeysOn() || e.ctrlKey || e.metaKey) ? k : "";
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

export const ALT_REFUSAL = "Alt is read by the tools, pick a key without it";

/** The refusal in the chosen language; the English text is plugin API, so only that one is translated. */
export function refusalLabel(refused: string, tr: typeof t = t): string {
  return refused === ALT_REFUSAL ? tr("shortcuts.problem.alt") : refused;
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
  // The platform chords of platform.ts without Alt, which the remap refuses anyway.
  "Ctrl+Shift+1": "Items",
  "Ctrl+Shift+2": "History",
  "Ctrl+`": "Console",
  "Ctrl+Shift+`": "Console",
  "Ctrl+=": "Interface size",
  "Ctrl++": "Interface size",
  "Ctrl+Shift+=": "Interface size",
  "Ctrl+Shift++": "Interface size",
  "Ctrl+-": "Interface size",
  "Ctrl+0": "Interface size",
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
  if (o.alt) return { refused: ALT_REFUSAL };
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
  if (c.alt) return { refused: ALT_REFUSAL };
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
  id: string;
  name: string;
  rows: { key: string; label: string; changed?: boolean; id?: string }[];
}

const CONTEXTS: readonly (readonly [Shortcut["context"], MessageKey])[] = [
  ["model", "shortcuts.group.model"],
  ["sketch", "tool.sketch"],
  ["global", "shortcuts.group.global"],
];

/** The editable rows of some actions, by context. Empty contexts are left out. */
export function shortcutGroupsOf(actions: ReadonlySet<string>, tr: Translate = t): HudGroup[] {
  return contextGroups((s) => actions.has(s.action), false, tr).filter((g) => g.rows.length);
}

function contextGroups(keep: (s: Shortcut) => boolean, core: boolean, tr: Translate): HudGroup[] {
  const mine = new Set(userOverrides.map((u) => u.id));
  const fixed = new Set(Object.keys(RESERVED));
  const shipped = new Set(SHORTCUTS.map((s) => s.action));
  const order = new Map(SHORTCUTS.map((s, i) => [idOf(s), i]));
  return CONTEXTS.map(([ctx, heading]) => ({
    id: ctx,
    name: tr(heading),
    rows: shortcutRows()
      .filter((s) => s.context === ctx && keep(s))
      .sort((a, b) => (order.get(a.id) ?? SHORTCUTS.length) - (order.get(b.id) ?? SHORTCUTS.length))
      .map((s) => {
        const user = mine.has(s.id);
        const changed = user || (core && shipped.has(s.action) && shortcutOverridden(s.action));
        return {
          key: s.key ? formatShortcut(s) : "",
          label: shortcutLabel(s, tr),
          ...(changed ? { changed: true } : {}),
          ...(fixed.has(formatShortcut(s)) ? {} : { id: s.id }),
        };
      }),
  }));
}

/** Pure: the dialog's General content. Exported so it is unit-testable without a DOM. `skip` leaves out actions another
 *  page shows. */
export function shortcutHudGroups(skip: ReadonlySet<string> = new Set(), tr: Translate = t): HudGroup[] {
  const fmt = formatShortcut;
  const clashes = shortcutConflicts().map(([a, b]) => ({
    key: fmt(a),
    label: `${shortcutLabel(a, tr)} and ${shortcutLabel(b, tr)} share this key, ${shortcutLabel(a, tr)} applies`,
  }));
  const custom = pointerBindings() !== DEFAULT_BINDINGS;
  return [
    ...(clashes.length ? [{ id: "conflicts", name: "Conflicts", rows: clashes }] : []),
    ...contextGroups((s) => !skip.has(s.action), true, tr),
    {
      id: "mouse",
      name: "Mouse",
      rows: [
        ...bindingRows(pointerBindings()).map((r) => (custom ? { ...r, changed: true } : r)),
        { key: "Wheel", label: "Zoom" },
        { key: "Ctrl+Wheel", label: "Pan up and down (a touchpad pinch zooms)" },
        { key: "Left drag", label: "Box select (see Always, below)" },
        { key: "Left click", label: "Select a body, then a face on it (pause over it to light the face up first)" },
      ],
    },
    {
      id: "focus",
      name: "3D view focused",
      rows: [
        { key: "] / [", label: "Step to the next / previous face, edge or plane, with a highlight" },
        { key: "Shift+] / Shift+[", label: "Switch what the brackets step: faces, edges, planes" },
        { key: "Enter", label: "Select the lit row, or start a sketch on a lit plane" },
        { key: "Space", label: "Add or remove the lit row" },
        { key: "Esc", label: "Drop the highlight and clear the selection" },
      ],
    },
    {
      id: "always",
      name: "Always",
      rows: [
        { key: "Ctrl+K", label: "Command palette" },
        { key: "Ctrl+Z / Ctrl+Y", label: "Undo / Redo" },
        { key: "Ctrl+S / Ctrl+Shift+S", label: "Save / Save As" },
        { key: "Ctrl+N / Ctrl+O / Ctrl+E", label: "New / Open / Export" },
        { key: "Ctrl+Plus / Ctrl+Minus / Ctrl+0", label: "Interface size larger / smaller / 100%" },
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
