// Inputs that take no typed text, so a focused one must not swallow the sketch keys.
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "color", "submit", "reset"]);

/** The base Select's button, whose typed letters search its list as a select's do. */
export const isSelectTrigger = (t: EventTarget | null) =>
  t instanceof HTMLElement && t.getAttribute("role") === "combobox";

/** Text inputs, textareas, selects, Select triggers and contentEditable, so typing "T" in a field does not start the
 *  Text tool. */
export function isEditableTarget(t: EventTarget | null): boolean {
  return (
    (t instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(t.type)) ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    isSelectTrigger(t) ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

/** False for a field removed, hidden, or put away by a key handler while the key was still on its way to the window
 *  (sketch/dimInput.ts does for undo and redo); the keymap lets the shortcut through then. */
export function isLiveFocusTarget(el: Element): boolean {
  if (!el.isConnected || document.activeElement !== el) return false;
  const s = getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden";
}

/** Ctrl or Cmd with Z or Y: undo and redo, Shift+Z included. */
export function isHistoryKey(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const k = e.key.toLowerCase();
  return k === "z" || k === "y";
}

/** Ctrl or Cmd with A outside a text field. Left to the browser it selects every label and button, turning the whole
 *  UI blue (PH-2). */
export function isPageSelectAll(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  if (e.key.toLowerCase() !== "a") return false;
  return !isEditableTarget(e.target) || isSelectTrigger(e.target);
}
