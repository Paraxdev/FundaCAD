export interface FrameClock {
  raf(cb: () => void): void;
  after(ms: number, cb: () => void): void;
  visible(): boolean;
  onVisible(cb: () => void): void;
}

const browserClock: FrameClock = {
  raf: (cb) => requestAnimationFrame(() => cb()),
  after: (ms, cb) => void setTimeout(cb, ms),
  visible: () => document.visibilityState === "visible",
  onVisible: (cb) => {
    const listener = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", listener);
      cb();
    };
    document.addEventListener("visibilitychange", listener);
  },
};

/** Calls `painted` after the second frame, or `stalled` once if a visible page gets no frame while its timers still
 *  run: WebKitGTK's compositor can wedge that way on some GPUs (the Steam Deck, src-tauri/src/webkit.rs). A hidden
 *  page gets no frames anyway, so its clock starts when it shows. The confirm wait lets a main thread that was busy
 *  past the budget get its frame before a stall is called. */
export function watchFirstFrame(
  painted: () => void,
  stalled: () => void,
  {
    budgetMs = 5000,
    confirmMs = 1000,
    clock = browserClock,
  }: { budgetMs?: number; confirmMs?: number; clock?: FrameClock } = {},
): void {
  let done = false;
  clock.raf(() =>
    clock.raf(() => {
      if (done) return;
      done = true;
      painted();
    }),
  );
  const check = () => {
    if (done) return;
    if (!clock.visible()) {
      clock.onVisible(() => clock.after(budgetMs, check));
      return;
    }
    clock.after(confirmMs, () => {
      if (done || !clock.visible()) return check();
      done = true;
      stalled();
    });
  };
  clock.after(budgetMs, check);
}
