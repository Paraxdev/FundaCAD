// The small name beside a snap marker, so a snap says what it caught ("Face Center").

import { announce, cancelAnnouncement } from "../ui/announce";
import { iconElement } from "../ui/icons";

export class SnapTag {
  private el: HTMLDivElement | null = null;
  private said = "";

  show(text: string, at: { x: number; y: number }) {
    // Every pointer move lands here, so only a new snap that holds for a moment is spoken.
    if (text !== this.said) {
      this.said = text;
      announce(text, "polite", { key: "snap", delay: 300 });
    }
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
    if (this.said) cancelAnnouncement("snap");
    this.said = "";
    if (this.el) this.el.hidden = true;
  }
}

/** The relations a shape being drawn will get, as icons beside the cursor. `data-relations` names them for tests. */
export class InferTag {
  private el: HTMLDivElement | null = null;
  private shown = "";

  show(icons: string[], relations: string[], at: { x: number; y: number }) {
    if (!icons.length) return this.hide();
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "snap-tag infer-tag";
      this.el.dataset.testid = "infer-tag";
      document.body.appendChild(this.el);
    }
    const key = icons.join(",");
    if (key !== this.shown) {
      this.el.replaceChildren(...icons.map((n) => iconElement(n, 14)));
      this.shown = key;
    }
    this.el.dataset.relations = relations.join(",");
    // Up and to the left of the cursor: the length and angle fields sit to its right.
    this.el.style.left = `${Math.round(at.x - 14)}px`;
    this.el.style.top = `${Math.round(at.y - 34)}px`;
    this.el.style.transform = "translateX(-100%)";
    this.el.hidden = false;
  }

  hide() {
    if (this.el) {
      this.el.hidden = true;
      this.el.dataset.relations = "";
    }
  }
}
