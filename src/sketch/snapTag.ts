// The small name beside a snap marker, so a snap says what it caught ("Face Center").

export class SnapTag {
  private el: HTMLDivElement | null = null;

  show(text: string, at: { x: number; y: number }) {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "snap-tag";
      this.el.dataset.testid = "snap-tag";
      document.body.appendChild(this.el);
    }
    this.el.textContent = text;
    this.el.style.left = `${Math.round(at.x + 12)}px`;
    this.el.style.top = `${Math.round(at.y - 26)}px`;
    this.el.hidden = false;
  }

  hide() {
    if (this.el) this.el.hidden = true;
  }
}
