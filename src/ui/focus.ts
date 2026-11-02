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

const MENU_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", "Tab"]);

/** A key a focused menu row moves, runs or types ahead with. Window capture listeners hear it before the menu does,
 *  so a tool asks here and leaves it, the way it asks escapeClaimed() for Escape. */
export function isMenuKey(e: KeyboardEvent): boolean {
  if (typeof Element === "undefined" || !(e.target instanceof Element && e.target.closest(".ui-menu"))) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  return MENU_KEYS.has(e.key) || (typeof e.key === "string" && e.key.length === 1);
}

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const roles = (names: string[]) => names.map((r) => `[role="${r}"]`);
const ARROW_WIDGETS = roles([
  "menu",
  "menubar",
  "listbox",
  "tablist",
  "radiogroup",
  "toolbar",
  "tree",
  "treegrid",
  "grid",
  "slider",
  "spinbutton",
  "combobox",
])
  .concat("input[type=range]", ".ui-menu")
  .join(",");
// Toolbars, tabs and radios leave out letters, Enter and Space, so E after clicking a rail button still starts Extrude.
const TYPING_WIDGETS = roles(["menu", "menubar", "listbox", "tree", "treegrid", "grid", "combobox"])
  .concat(".ui-menu")
  .join(",");

/** A key the focused widget moves, runs or types ahead with, or one a handler already took (defaultPrevented), so the
 *  global shortcuts leave it: an arrow in a menu, slider or tab list must not also turn the view (KB-4). Ctrl, Alt and
 *  Meta chords, Escape, Delete and the F keys still pass. */
export function widgetOwnsKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  if (typeof Element === "undefined" || !(e.target instanceof Element)) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (NAV_KEYS.has(e.key)) return e.target.closest(ARROW_WIDGETS) !== null;
  if (e.key === "Enter" || (typeof e.key === "string" && e.key.length === 1)) {
    return e.target.closest(TYPING_WIDGETS) !== null;
  }
  return false;
}

/** Enter or Space on a value box button (Confirm, Cancel, an option, a tool's extra control). Window capture
 *  listeners hear it before the button's own click, so a tool leaves it, the way it leaves isMenuKey. */
export function isBoxButtonKey(e: KeyboardEvent): boolean {
  if (e.key !== "Enter" && e.key !== " ") return false;
  if (typeof HTMLButtonElement === "undefined" || !(e.target instanceof HTMLButtonElement)) return false;
  return e.target.closest(".dim-input") !== null;
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
