// A press on the guide bubble must not count as an outside press, or Next would close what the step points into.
// This window capture listener is registered before the app mounts, so it runs ahead of every document listener.

export const GUIDE_BUBBLE = ".guide-bubble";

export function installGuidePressGuard(win: Window = window): () => void {
  const guard = (ev: Event) => {
    const t = ev.target;
    if (!(t instanceof Element) || !t.closest(GUIDE_BUBBLE)) return;
    ev.stopImmediatePropagation();
    // Keeps focus where it was, so a value box keeps its input while Next is pressed.
    ev.preventDefault();
  };
  win.addEventListener("pointerdown", guard, true);
  win.addEventListener("mousedown", guard, true);
  return () => {
    win.removeEventListener("pointerdown", guard, true);
    win.removeEventListener("mousedown", guard, true);
  };
}
