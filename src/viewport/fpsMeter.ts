// Frame time readout. Rendering is on demand, so no frames reads `render idle` rather than 0 fps, and the ms figure
// leads because the rate is capped by the display refresh.

/** Frames older than this are dropped from the rolling window. */
const WINDOW_MS = 1000;
/** No rendered frame for this long = the app is idle, not slow. */
const IDLE_AFTER_MS = 400;
/** DOM writes per second. The readout only has to be readable, not live. */
const REFRESH_MS = 250;

export class FpsMeter {
  private stamps: number[] = [];
  private el: HTMLElement | null;
  private timer = 0;

  constructor(host: HTMLElement | null = null) {
    this.el = host;
    if (this.el) this.start();
  }

  /** The Viewport builds this in a field initializer, before the Vue shell has rendered #fps, so FpsReadout.vue hands the
   *  element over in onMounted. */
  setHost(host: HTMLElement) {
    if (this.el) return;
    this.el = host;
    this.start();
  }

  private start() {
    if (!this.timer) this.timer = window.setInterval(() => this.paint(), REFRESH_MS);
  }

  /** Once per frame actually drawn, not per rAF tick: the loop skips idle draws, and counting those reads a steady 60. */
  frame(now = performance.now()) {
    this.stamps.push(now);
    // bounded by refresh rate * WINDOW_MS, so a plain shift-while is fine
    while (this.stamps.length && now - this.stamps[0]! > WINDOW_MS) this.stamps.shift();
  }

  private paint() {
    if (!this.el) return;
    const gpu = (window as { __gpu?: string }).__gpu;
    const gpuLine = gpu ? `\nGPU: ${gpu}` : "";
    const now = performance.now();
    const last = this.stamps[this.stamps.length - 1];
    if (last === undefined || now - last > IDLE_AFTER_MS) {
      // Not "idle" alone: beside the history's build state that read as the engine's.
      this.show(
        "render idle",
        "The viewport only draws when something changes, nothing to render right now. This says nothing about the geometry engine." +
          gpuLine,
      );
      return;
    }
    // Rate over the window, and the mean interval between the frames in it.
    // Both come from the same samples, so they can't disagree.
    const first = this.stamps[0]!;
    const span = last - first;
    const n = this.stamps.length;
    if (n < 2 || span <= 0) return; // too few samples this tick; keep the last text
    const fps = ((n - 1) / span) * 1000;
    const ms = span / (n - 1);
    this.show(
      `${Math.round(fps)} fps · ${ms.toFixed(1)} ms`,
      `${n} frames drawn in the last ${Math.round(span)}ms. ` +
        "The viewport renders on demand, so this only counts frames that were actually drawn." +
        gpuLine,
    );
  }

  /** Even an identical textContent write repaints and re-blurs every glass panel; four times a second under a software
   *  renderer that kept two to three cores busy. */
  private show(text: string, title: string) {
    if (!this.el) return;
    if (this.el.textContent !== text) this.el.textContent = text;
    if (this.el.title !== title) this.el.title = title;
  }

  /** Most recent mean frame time in ms, or null when idle. Read by the bug
   *  reporter so a performance complaint carries the number with it. */
  lastFrameMs(): number | null {
    const now = performance.now();
    const last = this.stamps[this.stamps.length - 1];
    if (last === undefined || now - last > IDLE_AFTER_MS) return null;
    const n = this.stamps.length;
    if (n < 2) return null;
    return (last - this.stamps[0]!) / (n - 1);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  }
}
