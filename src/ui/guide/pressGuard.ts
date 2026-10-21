// A press on the guide bubble must not count as a press outside the popover,
// menu or value box the step points into, or pressing Next would close it.
// One window capture listener, registered before the app mounts, runs ahead of
// every document listener that closes something on an outside press.

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
