// The box drag rubber band, a DOM div rather than scene geometry so it stays one pixel wide at any zoom.

import type { AreaMode } from "./areaSelect";

export class AreaBox {
  private el: HTMLDivElement | null = null;

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
    // A band that took events would swallow the pointerup ending its own drag.
    el.style.pointerEvents = "none";
    document.body.appendChild(el);
    this.el = el;
    return el;
  }
}
