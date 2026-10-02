// Which kind of pointer the user is on right now: a finger, a pen or a mouse
// (a touchpad is a mouse to the browser).
//
// A laptop with a touchscreen has both, and its media queries say "fine
// pointer" whichever one is in use, so the kind is taken from the last pointer
// event instead. The listener is a window capture one, so it has run before any
// canvas, tool or component handler of the same event reads it, and hit tests
// that only get coordinates still size themselves for the finger that made them.
//
// The kind is also put on <html data-pointer="…"> for the stylesheet.

export type PointerKind = "mouse" | "pen" | "touch";

/** How much bigger a target is for a finger than for a mouse. */
export const TOUCH_HIT_SCALE = 2;

let kind: PointerKind = "mouse";

function note(e: PointerEvent) {
  const k: PointerKind = e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse";
  // A synthetic event with no type leaves the kind as it was.
  if (!e.pointerType || k === kind) return;
  kind = k;
  if (typeof document !== "undefined") document.documentElement.dataset.pointer = k;
}

let installed = false;

export function installPointerKind(win: Window = window) {
  if (installed) return;
  installed = true;
  const opts = { capture: true, passive: true };
  win.addEventListener("pointerdown", note, opts);
  win.addEventListener("pointermove", note, opts);
  if (typeof document !== "undefined") document.documentElement.dataset.pointer = kind;
}

export function pointerKind(): PointerKind {
  return kind;
}

/** The multiplier for pixel tolerances and hit radii: 2 for a finger, else 1. */
export function hitScale(): number {
  return kind === "touch" ? TOUCH_HIT_SCALE : 1;
}

/** A pixel tolerance sized for the pointer in use. */
export function hitPx(px: number): number {
  return px * hitScale();
}

/** For tests: set the kind as if a pointer of it had just moved. */
export function setPointerKindForTest(k: PointerKind) {
  kind = k;
}
