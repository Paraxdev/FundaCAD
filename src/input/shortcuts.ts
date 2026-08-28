// Single source of truth for keyboard shortcuts. keymap.ts dispatches from this
// table, commands.ts reads its hint column, and the `?` HUD renders it — so the
// three surfaces can never disagree again (they did: M/T were emitted but never
// dispatched, the palette advertised Fit on "F" while F ran Fillet, and the
// ribbon promised sketch Offset on "O" with no binding behind it).

import { useUiStore } from "../stores/ui";

export interface Shortcut {
  key: string; // normalized lowercase key ("b", "home", "f6", "?")
  shift?: boolean;
  /** Ctrl (or Cmd) must be held.
   *
   *  Only the booleans use it, and they use it because the three single letters
   *  that name them — U, B, I — are already Clean Up, Chamfer and Measure, and a
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
  { key: "2", action: "selmode-bodies", context: "model", label: "Select bodies" },
  { key: "x", action: "toggle-xray", context: "model", label: "See through (select what is behind)" },
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
  // finish-and-go: E/Q inside a sketch commit it and start the 3D tool
  // (handleAction already finishes an active sketch before any 3D command)
  { key: "e", action: "extrude", context: "sketch", label: "Finish & Extrude" },
  { key: "q", action: "presspull", context: "sketch", label: "Finish & Press/Pull" },
  // sketch-start conveniences from model mode (L/C/R/A/P start a sketch with that tool)
  { key: "l", action: "line", context: "model", label: "Sketch: Line" },
  { key: "c", action: "circle", context: "model", label: "Sketch: Circle" },
  { key: "r", action: "rectangle", context: "model", label: "Sketch: Rectangle" },
  { key: "a", action: "arc", context: "model", label: "Sketch: Arc" },
  { key: "p", action: "project", context: "model", label: "Sketch: Project" },
  // --- global ---
  { key: "home", action: "fit", context: "global", label: "Fit view" },
  { key: "f6", action: "fit", context: "global", label: "Fit view" },
  { key: "?", action: "shortcut-help", context: "global", label: "Shortcut help" },
];

/** How a shortcut is written for a human ("Shift+H", "Ctrl+U", "Home").
 *
 *  One formatter, used by keyHint below and by the `?` HUD, because those two
 *  drifting is exactly the failure this file exists to prevent: a cheat sheet
 *  that advertises a key nothing binds. */
export function formatShortcut(s: Shortcut): string {
  const k = s.key.length === 1 ? s.key.toUpperCase() : s.key.charAt(0).toUpperCase() + s.key.slice(1);
  return `${s.ctrl ? "Ctrl+" : ""}${s.shift ? "Shift+" : ""}${k}`;
}

/** first key hint for an action ("Shift+H", "Ctrl+U", "Home"), for menus/palette. */
export function keyHint(action: string): string | undefined {
  const s = SHORTCUTS.find((x) => x.action === action);
  return s ? formatShortcut(s) : undefined;
}

/** Resolve a keydown to an action for the current context (sketch keys win
 *  while sketching; model keys otherwise; global always). */
export function resolveShortcut(
  key: string,
  shift: boolean,
  context: "model" | "sketch",
  ctrl = false,
): string | null {
  const k = key.toLowerCase();
  for (const s of SHORTCUTS) {
    // Every flag is compared, including the absent ones. A bare "b" must not
    // resolve to Ctrl+B's action and Ctrl+B must not resolve to bare B's: the
    // two are different commands, and the pair that would collide here is
    // Chamfer and Subtract.
    if (s.key !== k || !!s.shift !== shift || !!s.ctrl !== ctrl) continue;
    if (s.context === "global" || s.context === context) return s.action;
  }
  return null;
}

// --- the `?` cheat-sheet HUD: auto-generated, dismissed by any key/click ---

/** One rendered section of the HUD. Derived from SHORTCUTS so the cheat sheet
 *  cannot drift from what the dispatcher actually does — the whole point of this
 *  file being the single source of truth. */
export interface HudGroup {
  name: string;
  rows: { key: string; label: string }[];
}

/** Pure: the HUD's content. Exported so it is unit-testable without a DOM. */
export function shortcutHudGroups(): HudGroup[] {
  const fmt = formatShortcut;
  const byContext = (ctx: Shortcut["context"]) =>
    SHORTCUTS.filter((s) => s.context === ctx).map((s) => ({ key: fmt(s), label: s.label }));
  return [
    { name: "Model", rows: byContext("model") },
    { name: "Sketch", rows: byContext("sketch") },
    { name: "Global", rows: byContext("global") },
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
        // for it is here.
        { key: "Drag", label: "Box select: right takes what is inside, left takes what it touches" },
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
