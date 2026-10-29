import { describe, expect, it } from "vitest";
import { watchFirstFrame, type FrameClock } from "../../src/app/firstFrame";

/** A hand cranked clock: frames run only when `frame()` is called, timers when `advance` passes them. */
function fakeClock() {
  let now = 0;
  let frames: (() => void)[] = [];
  let timers: { at: number; cb: () => void }[] = [];
  let shown: (() => void)[] = [];
  const state = { visible: true };
  const clock: FrameClock = {
    raf: (cb) => void frames.push(cb),
    after: (ms, cb) => void timers.push({ at: now + ms, cb }),
    visible: () => state.visible,
    onVisible: (cb) => void shown.push(cb),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers = timers.slice(1);
      now = next.at;
      next.cb();
    }
    now = end;
  };
  const frame = () => {
    const due = frames;
    frames = [];
    due.forEach((cb) => cb());
  };
  const show = () => {
    state.visible = true;
    const due = shown;
    shown = [];
    due.forEach((cb) => cb());
  };
  return { clock, advance, frame, show, state };
}

function watch(c: ReturnType<typeof fakeClock>) {
  const seen: string[] = [];
  watchFirstFrame(
    () => seen.push("painted"),
    () => seen.push("stalled"),
    { budgetMs: 5000, confirmMs: 1000, clock: c.clock },
  );
  return seen;
}

describe("watchFirstFrame", () => {
  it("reports a painted start after the second frame and never a stall", () => {
    const c = fakeClock();
    const seen = watch(c);
    c.frame();
    expect(seen).toEqual([]);
    c.frame();
    c.advance(60_000);
    expect(seen).toEqual(["painted"]);
  });

  it("reports a stall once when timers run but no frame comes, as on the Steam Deck", () => {
    const c = fakeClock();
    const seen = watch(c);
    c.advance(5999);
    expect(seen).toEqual([]);
    c.advance(1);
    c.advance(60_000);
    expect(seen).toEqual(["stalled"]);
  });

  it("gives a main thread that was busy past the budget its frame before calling a stall", () => {
    const c = fakeClock();
    const seen = watch(c);
    c.advance(5000);
    c.frame();
    c.frame();
    c.advance(60_000);
    expect(seen).toEqual(["painted"]);
  });

  it("does not call a stall on a hidden window, and starts the clock when it shows", () => {
    const c = fakeClock();
    c.state.visible = false;
    const seen = watch(c);
    c.advance(60_000);
    expect(seen).toEqual([]);
    c.show();
    c.advance(5999);
    expect(seen).toEqual([]);
    c.advance(1);
    expect(seen).toEqual(["stalled"]);
  });

  it("waits again when the window hides during the confirm wait", () => {
    const c = fakeClock();
    const seen = watch(c);
    c.advance(5000);
    c.state.visible = false;
    c.advance(60_000);
    expect(seen).toEqual([]);
    c.show();
    c.frame();
    c.frame();
    expect(seen).toEqual(["painted"]);
  });
});
