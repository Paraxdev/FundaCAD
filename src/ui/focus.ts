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

/** False for a field that lost its reason to hold focus, hidden (display:none
 *  or visibility:hidden) or removed from the document, but is still
 *  document.activeElement for one more frame (a hand-rolled overlay like
 *  sketch/dimInput.ts clears its own DOM asynchronously). A ghost like that
 *  must not swallow every future keyboard shortcut forever, undo included
 *  (the bug this exists for: one Ctrl+Z lands, then every further one and
 *  every Ctrl+Y do nothing because focus never left the field the FIRST
 *  undo's tool left behind). A genuinely live field still should. */
export function isLiveFocusTarget(el: Element): boolean {
  if (!el.isConnected) return false;
  const s = getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden";
}

/** Blur document.activeElement if it looks like a ghost field (see above). */
export function releaseStaleFocus(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body && !isLiveFocusTarget(el)) el.blur();
}
