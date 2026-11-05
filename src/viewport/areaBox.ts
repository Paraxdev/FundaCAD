// The box drag rubber band, a DOM div rather than scene geometry so it stays one pixel wide at any zoom.

import type { AreaMode } from "./areaSelect";
import { pageZoom } from "../ui/interfaceSize";

export class AreaBox {
  private el: HTMLDivElement | null = null;

  /** The corners are in window pixels, the box in the CSS pixels of the root zoom. */
  show(x0: number, y0: number, x1: number, y1: number, mode: AreaMode) {
    const el = this.el ?? this.make();
    const z = pageZoom();
    el.className = `areabox ${mode}`;
    el.style.left = `${x0 / z}px`;
    el.style.top = `${y0 / z}px`;
    el.style.width = `${Math.max(0, x1 - x0) / z}px`;
    el.style.height = `${Math.max(0, y1 - y0) / z}px`;
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
