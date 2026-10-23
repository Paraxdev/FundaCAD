// What the engine says a rebuild is doing (build_phase.rs), plus the one phase only the app can know.
export const BUILD_PHASE = { preparing: 0, feature: 1, saving: 2, meshing: 3, assembling: 4, applying: 5 } as const;

// A reply that came back faster than this commits before anyone reads a label.
export const APPLY_LABEL_AFTER_MS = 300;

// Two frames put the label on screen before the synchronous commit freezes the page. A hidden tab never runs
// frames, so the timer lets the commit through.
export function afterPaint(fallbackMs = 100): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, fallbackMs);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }),
    );
  });
}
