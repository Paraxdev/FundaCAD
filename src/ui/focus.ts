/** True when a keyboard event targets a text-entry field, inputs, textareas,
 *  selects, or contentEditable, so global/tool keyboard shortcuts must NOT fire
 *  (otherwise typing "T" in a field would trigger the Text tool, etc.). */
export function isEditableTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

/** False for a field that no longer holds the typing: removed, hidden, or no
 *  longer document.activeElement because a key handler put it away while the
 *  key was still on its way to the window (sketch/dimInput.ts does, for undo
 *  and redo). The keymap lets the shortcut through for one of those. */
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
