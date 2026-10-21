// The Realtime frame fading out over the first traced frames once the view
// rests, so the switch between the two looks does not flash.

import { CROSSFADE_MS } from "./denoise";

export class SettleFade {
  private from = -Infinity;

  begin(now: number) {
    this.from = now;
  }

  stop() {
    this.from = -Infinity;
  }

  /** The Realtime frame's opacity over the trace, 1 at the switch down to 0. */
  opacity(now: number): number {
    if (this.from === -Infinity) return 0;
    // A frame time read before the fade began, in the same frame, counts as its start.
    const t = Math.max(0, (now - this.from) / CROSSFADE_MS);
    return t >= 1 ? 0 : 1 - t;
  }

  active(now: number): boolean {
    return this.opacity(now) > 0;
  }
}

/** A copy of the last Realtime frame between the traced canvas and the WebGL
 *  one, faded out while the overlays keep drawing on top. */
export class RealtimeFreeze {
  private el: HTMLCanvasElement | null = null;
  private fade = new SettleFade();

  constructor(private gl: HTMLCanvasElement) {}

  /** Copies the frame on the WebGL canvas. Must run in the task that drew it:
   *  without preserveDrawingBuffer a later read is blank. */
  capture(now: number) {
    const gl = this.gl;
    const parent = gl.parentElement;
    if (!parent) return;
    const el = (this.el ??= document.createElement("canvas"));
    if (el.width !== gl.width || el.height !== gl.height) {
      el.width = gl.width;
      el.height = gl.height;
    }
    const g = el.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, el.width, el.height);
    g.drawImage(gl, 0, 0);
    // Moved back every time: a tracer started later puts its canvas before the WebGL one too.
    parent.insertBefore(el, gl);
    const st = el.style;
    st.position = "absolute";
    st.pointerEvents = "none";
    st.left = `${gl.offsetLeft}px`;
    st.top = `${gl.offsetTop}px`;
    st.width = `${gl.clientWidth}px`;
    st.height = `${gl.clientHeight}px`;
    st.opacity = "1";
    st.display = "";
    this.fade.begin(now);
  }

  /** True while the fade is still running. */
  step(now: number): boolean {
    const el = this.el;
    if (!el || el.style.display === "none") return false;
    const o = this.fade.opacity(now);
    if (o <= 0) {
      el.style.display = "none";
      return false;
    }
    el.style.opacity = o.toFixed(3);
    return true;
  }

  stop() {
    this.fade.stop();
    if (this.el) this.el.style.display = "none";
  }

  dispose() {
    this.el?.remove();
    this.el = null;
  }
}
