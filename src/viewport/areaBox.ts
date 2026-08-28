// The rubber band itself: one absolutely-positioned div over the canvas.
//
// A DOM rectangle rather than geometry in the scene, because it is not in the
// scene: it lives in screen pixels, it must be exactly one pixel wide at any
// zoom, and it has to survive the frame where the model is mid-rebuild. Drawing
// it in WebGL would mean an orthographic overlay camera and a render request per
// pointer move, to produce something the browser draws for free.
//
// It carries WHICH box it is in its class, because the two verdicts have to be
// told apart while the drag is still happening — after the release it is too
// late for the difference to be information.

import type { AreaMode } from "./areaSelect";

export class AreaBox {
  private el: HTMLDivElement | null = null;

  /** Place and show the band. `mode` decides how it is dressed. */
  show(x0: number, y0: number, x1: number, y1: number, mode: AreaMode) {
    const el = this.el ?? this.make();
    el.className = `areabox ${mode}`;
    el.style.left = `${x0}px`;
    el.style.top = `${y0}px`;
    el.style.width = `${Math.max(0, x1 - x0)}px`;
    el.style.height = `${Math.max(0, y1 - y0)}px`;
  }

  hide() {
    this.el?.remove();
    this.el = null;
  }

  get visible(): boolean {
    return this.el !== null;
  }

  private make(): HTMLDivElement {
    const el = document.createElement("div");
    // Never a pointer target: the band follows the cursor, so a band that took
    // events would take the pointerup that ends the very drag drawing it.
    el.style.pointerEvents = "none";
    document.body.appendChild(el);
    this.el = el;
    return el;
  }
}
