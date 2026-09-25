/** Run `pick` on the next frame, so the press that made the pick cannot also act
 *  on whatever the pick opens, or at once when a new press reaches `target`
 *  before that frame. On a slow machine a frame outlasts a quick first click, and
 *  a sketch's first rectangle corner landed in the model and was lost (PH-1).
 *  Running from a window capture listener lets the opened tool's own listeners
 *  on `target` still receive that press. */
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
