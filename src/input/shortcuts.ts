// Single source of truth for keyboard shortcuts. keymap.ts dispatches from this
// table, commands.ts reads its hint column, and the `?` HUD renders it, so the
// three surfaces can never disagree again (they did: M/T were emitted but never
// dispatched, the palette advertised Fit on "F" while F ran Fillet, and the
// ribbon promised sketch Offset on "O" with no binding behind it).

import { useUiStore } from "../stores/ui";
import { DEFAULT_BINDINGS, bindingRows, pointerBindings } from "../viewport/navigator/bindings";

export interface Shortcut {
  key: string; // normalized lowercase key ("b", "home", "f6", "?")
  shift?: boolean;
  /** Ctrl (or Cmd) must be held.
   *
   *  Only the booleans use it, and they use it because the three single letters
   *  that name them, U, B, I, are already Clean Up, Chamfer and Measure, and a
   *  family of three commands wants three keys that read as a family rather than
   *  whichever letters happened to be free. Everything else here is bare: a
   *  modeling app's tool keys are meant to be hit one-handed while the other
   *  hand is on the mouse. */
  ctrl?: boolean;
  action: string; // action id fed to main's handleAction (or a special-cased id)
  context: "model" | "sketch" | "global";
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  // --- model context ---
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
  // --- sketch context ---
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
  // finish-and-go: E/Q inside a sketch commit it and start the 3D tool
  // (handleAction already finishes an active sketch before any 3D command)
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
  // --- global ---
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

/** How a shortcut is written for a human ("Shift+H", "Ctrl+U", "Home").
 *
 *  One formatter, used by keyHint below and by the `?` HUD, because those two
 *  drifting is exactly the failure this file exists to prevent: a cheat sheet
 *  that advertises a key nothing binds. */
export function formatShortcut(s: Shortcut): string {
  const name = s.key.replace(/^arrow/, "");
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
    // Every flag is compared, including the absent ones. A bare "b" must not
    // resolve to Ctrl+B's action and Ctrl+B must not resolve to bare B's: the
    // two are different commands, and the pair that would collide here is
    // Chamfer and Subtract.
    if (s.key !== k || !!s.shift !== shift || !!s.ctrl !== ctrl) continue;
    if (s.context === "global" || s.context === context) return s.action;
  }
  return null;
}

// --- overrides: a plugin holding input.remap may move a key ----------------------

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

let overrides: ShortcutOverride[] = [];
let active: Shortcut[] | null = null;

const sameCombo = (a: Pick<Shortcut, "key" | "shift" | "ctrl">, b: Pick<Shortcut, "key" | "shift" | "ctrl">) =>
  a.key === b.key && !!a.shift === !!b.shift && !!a.ctrl === !!b.ctrl;
const combo = (o: { key: string; shift?: boolean; ctrl?: boolean }): Pick<Shortcut, "key" | "shift" | "ctrl"> => ({
  key: o.key.toLowerCase(),
  ...(o.shift ? { shift: true } : {}),
  ...(o.ctrl ? { ctrl: true } : {}),
});
const overlap = (a: Shortcut["context"], b: Shortcut["context"]) => a === b || a === "global" || b === "global";

/** The table with the overrides applied, overridden rows first so a key the
 *  user chose is preferred over the table's own use of it. */
export function activeShortcuts(): Shortcut[] {
  if (active) return active;
  const moved = new Map(overrides.map((o) => [o.action, o]));
  const mine: Shortcut[] = [];
  for (const o of overrides) {
    if (!o.key) continue;
    const rows = SHORTCUTS.filter((s) => s.action === o.action);
    const base = rows.length
      ? rows
      : [{ action: o.action, context: o.context ?? "global", label: o.label ?? o.action, key: "" } as Shortcut];
    for (const r of base) {
      const { shift: _s, ctrl: _c, ...rest } = r;
      mine.push({ ...rest, ...combo(o), context: o.context ?? r.context });
    }
  }
  active = [...mine, ...SHORTCUTS.filter((s) => !moved.has(s.action))];
  return active;
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
  if ("conflict" in p) return `${formatShortcut(p.conflict)} is already ${p.conflict.label}`;
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
  return out;
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

// --- the `?` cheat-sheet HUD: auto-generated, dismissed by any key/click ---

/** One rendered section of the HUD. Derived from SHORTCUTS so the cheat sheet
 *  cannot drift from what the dispatcher actually does, the whole point of this
 *  file being the single source of truth. */
export interface HudGroup {
  name: string;
  rows: { key: string; label: string; changed?: boolean }[];
}

/** Pure: the HUD's content. Exported so it is unit-testable without a DOM. */
export function shortcutHudGroups(): HudGroup[] {
  const fmt = formatShortcut;
  const byContext = (ctx: Shortcut["context"]) =>
    activeShortcuts()
      .filter((s) => s.context === ctx)
      .map((s) =>
        shortcutOverridden(s.action) ? { key: fmt(s), label: s.label, changed: true } : { key: fmt(s), label: s.label },
      );
  const clashes = shortcutConflicts().map(([a, b]) => ({
    key: fmt(a),
    label: `${a.label} and ${b.label} share this key, ${a.label} applies`,
  }));
  const custom = pointerBindings() !== DEFAULT_BINDINGS;
  return [
    ...(clashes.length ? [{ name: "Conflicts", rows: clashes }] : []),
    { name: "Model", rows: byContext("model") },
    { name: "Sketch", rows: byContext("sketch") },
    { name: "Global", rows: byContext("global") },
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
        // A gesture rather than a key, and the only place anyone would look
        // for it is here. "right"/"left" name the drag direction, not a mouse
        // button, everything here is a left-button drag.
        {
          key: "Drag",
          label:
            "Box select: dragging to the right takes what is fully inside, dragging to the left takes what it touches",
        },
        { key: "Shift+Drag", label: "Box select, adding to what is selected" },
        { key: "Tab", label: "While boxing: take everything / faces / edges" },
      ],
    },
  ];
}

/** Toggle the HUD. Facade over stores/ui.ts, rendered by
 *  components/overlays/ShortcutHud.vue; the signature is unchanged for its two
 *  callers (the Help menu and the "shortcut-help" action). */
export function toggleShortcutHUD() {
  const ui = useUiStore();
  ui.shortcutHudOpen = !ui.shortcutHudOpen;
}
