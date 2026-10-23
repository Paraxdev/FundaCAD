// The MCAD-style keymap, dispatching from the table in shortcuts.ts. File shortcuts are handled in main.ts.

import { resolveShortcut } from "./shortcuts";
import { isEditableTarget, isLiveFocusTarget } from "../ui/focus";

export function installKeymap(onAction: (a: string) => void, context: () => "model" | "sketch") {
  window.addEventListener("keydown", (e) => {
    if (isEditableTarget(e.target)) {
      // A ghost field (ui/focus.ts): blur it and fall through, or it swallows this shortcut and every later one.
      if (e.target instanceof HTMLElement && !isLiveFocusTarget(e.target)) e.target.blur();
      else return;
    }
    const k = e.key.toLowerCase();

    if (e.ctrlKey || e.metaKey) {
      if (k === "z" && !e.shiftKey) return (onAction("undo"), e.preventDefault());
      if (k === "z" && e.shiftKey) return (onAction("redo"), e.preventDefault());
      if (k === "y") return (onAction("redo"), e.preventDefault());
      // Ctrl combos the table binds (the booleans), resolved like bare keys. preventDefault matters here: in a browser
      // tab Ctrl+U, Ctrl+B and Ctrl+I are view-source, bookmarks and devtools.
      const ctrlAction = resolveShortcut(k, e.shiftKey, context(), true);
      if (ctrlAction) {
        e.preventDefault();
        return onAction(ctrlAction);
      }
      // file shortcuts (Ctrl+S/N/O/E) are handled centrally in main.ts
      return;
    }

    if (e.key === "Escape") return onAction("escape");

    // "?" arrives as key "?" with shift held, resolve it without the shift flag
    const key = e.key === "?" ? "?" : k;
    const shift = e.key === "?" ? false : e.shiftKey;
    const action = resolveShortcut(key, shift, context());
    if (action) {
      // Keep the keystroke out of any input a tool focuses in response (Press/Pull's dimension box).
      e.preventDefault();
      onAction(action);
    }
  });
}
