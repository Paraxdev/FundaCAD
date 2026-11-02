// The element that holds focus while a sketch is drawn by keys. A screen reader leaves a role=application element to
// the page, so Enter, digits and arrows reach the sketch instead of being eaten in browse mode.

export class KeySurface {
  private el: HTMLElement | null = null;
  private stop = false;

  /** Puts the element in the Model area, or the body when there is none. */
  mount(parent: Element = document.getElementById("main") ?? document.body) {
    if (this.el?.isConnected) return;
    const el = document.createElement("div");
    el.className = "sr-only";
    el.setAttribute("data-key-surface", "");
    el.setAttribute("role", "application");
    el.setAttribute("aria-label", "Sketch");
    el.setAttribute("aria-describedby", "prompt");
    el.tabIndex = this.stop ? 0 : -1;
    parent.appendChild(el);
    this.el = el;
  }

  setStop(on: boolean) {
    this.stop = on;
    if (this.el) this.el.tabIndex = on ? 0 : -1;
  }

  focus(): boolean {
    const el = this.el;
    if (!el?.isConnected || el.tabIndex < 0) return false;
    el.focus({ preventScroll: true });
    return document.activeElement === el;
  }

  dispose() {
    this.el?.remove();
    this.el = null;
  }
}
