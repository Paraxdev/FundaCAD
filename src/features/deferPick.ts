/** Runs `pick` next frame so its press cannot act on what it opens, or at once when a new press reaches `target`
 *  first: on a slow machine a frame outlasts a quick click and a sketch's first corner was lost (PH-1).
 *  The window capture listener still lets the opened tool's own listeners on `target` get that press. */
export function deferPick(target: EventTarget, pick: () => void, win: Window = window): void {
  let frame = 0;
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    win.cancelAnimationFrame(frame);
    win.removeEventListener("pointerdown", early, true);
    pick();
  };
  const early = (e: Event) => {
    if (e.target === target) run();
  };
  win.addEventListener("pointerdown", early, true);
  frame = win.requestAnimationFrame(run);
}
