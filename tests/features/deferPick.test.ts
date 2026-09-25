// PH-1: picking the sketch plane opened the sketch a frame later, and on a slow
// machine the first rectangle corner clicked inside that frame went to the model
// and was lost; the second corner started the rectangle, and Escape then left
// an empty sketch.

import { describe, expect, it } from "vitest";
import { deferPick } from "../../src/features/deferPick";

function fakeWindow() {
  const bus = new EventTarget();
  const frames: (() => void)[] = [];
  const win = Object.assign(bus, {
    requestAnimationFrame: (cb: () => void) => frames.push(cb),
    cancelAnimationFrame: (id: number) => { frames[id - 1] = () => {}; },
  }) as unknown as Window;
  return { win, frames };
}

/** A press as the window capture listener sees it: aimed at `target`. */
function press(win: Window, target: EventTarget) {
  const e = new Event("pointerdown");
  Object.defineProperty(e, "target", { value: target });
  win.dispatchEvent(e);
}

describe("deferPick", () => {
  it("runs on the next frame when nothing else happens", () => {
    const { win, frames } = fakeWindow();
    const canvas = new EventTarget();
    let runs = 0;
    deferPick(canvas, () => runs++, win);
    expect(runs).toBe(0);
    frames.forEach((f) => f());
    expect(runs).toBe(1);
  });

  it("runs at once when a new press reaches the canvas before that frame, and only once", () => {
    const { win, frames } = fakeWindow();
    const canvas = new EventTarget();
    let runs = 0;
    deferPick(canvas, () => runs++, win);
    press(win, canvas);
    expect(runs).toBe(1);
    frames.forEach((f) => f());
    press(win, canvas);
    expect(runs).toBe(1);
  });

  it("a press elsewhere does not open it early", () => {
    const { win } = fakeWindow();
    const canvas = new EventTarget();
    let runs = 0;
    deferPick(canvas, () => runs++, win);
    press(win, new EventTarget());
    expect(runs).toBe(0);
  });
});
