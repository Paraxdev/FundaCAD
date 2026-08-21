// MCAD-style keymap, driven by the single shortcut table in shortcuts.ts —
// the app decides what each action does (main.ts dispatch). Ignores keystrokes
// while typing in inputs. Ctrl/Cmd combos handle undo/redo (file shortcuts are
// handled centrally in main.ts).

import { resolveShortcut } from "./shortcuts";

export function installKeymap(
  onAction: (a: string) => void,
  context: () => "model" | "sketch",
) {
  window.addEventListener("keydown", (e) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target instanceof HTMLElement && e.target.isContentEditable)
    ) {
      return;
    }
    const k = e.key.toLowerCase();

    if (e.ctrlKey || e.metaKey) {
      if (k === "z" && !e.shiftKey) return onAction("undo"), e.preventDefault();
      if (k === "z" && e.shiftKey) return onAction("redo"), e.preventDefault();
      if (k === "y") return onAction("redo"), e.preventDefault();
      // Ctrl combos the table binds — the booleans. Resolved through the same
      // function as the bare keys, so the cheat sheet, the ribbon hints and the
      // dispatcher still have one source between them.
      //
      // preventDefault matters more here than anywhere else in this file: the
      // three are Ctrl+U, Ctrl+B and Ctrl+I, which in a browser are view-source,
      // the bookmarks bar and (on some builds) devtools. Swallowing them is what
      // makes the binding real when the app is run in a tab rather than packaged.
      const ctrlAction = resolveShortcut(k, e.shiftKey, context(), true);
      if (ctrlAction) {
        e.preventDefault();
        return onAction(ctrlAction);
      }
      // file shortcuts (Ctrl+S/N/O/E) are handled centrally in main.ts
      return;
    }

    if (e.key === "Escape") return onAction("escape");

    // "?" arrives as key "?" with shift held — resolve it without the shift flag
    const key = e.key === "?" ? "?" : k;
    const shift = e.key === "?" ? false : e.shiftKey;
    const action = resolveShortcut(key, shift, context());
    if (action) {
      // Stop the keystroke from also landing in any input a tool focuses in
      // response (e.g. Press/Pull's dimension box) — otherwise "q" types into it.
      e.preventDefault();
      onAction(action);
    }
  });
}
