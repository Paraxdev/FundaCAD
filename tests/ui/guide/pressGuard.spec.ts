import { afterEach, describe, expect, it, vi } from "vitest";
import { installGuidePressGuard } from "../../../src/ui/guide/pressGuard";

describe("the guide bubble's press guard", () => {
  let remove = () => {};
  afterEach(() => {
    remove();
    document.body.innerHTML = "";
  });

  it("keeps an open flyout open on a press in the bubble, and still closes it on a press elsewhere", () => {
    remove = installGuidePressGuard(window);
    document.body.innerHTML = `<div class="float-popover"></div><button id="other"></button>
      <div class="guide-bubble"><button id="guide-next">Next</button></div>`;
    const outside = vi.fn();
    document.addEventListener("pointerdown", outside, true);
    const press = (sel: string) => {
      const ev = new Event("pointerdown", { bubbles: true, cancelable: true });
      document.querySelector(sel)!.dispatchEvent(ev);
      return ev;
    };
    const ev = press("#guide-next");
    expect(outside).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
    press("#other");
    expect(outside).toHaveBeenCalledTimes(1);
    document.removeEventListener("pointerdown", outside, true);
  });

  it("lets a click on Next through", () => {
    remove = installGuidePressGuard(window);
    document.body.innerHTML = `<div class="guide-bubble"><button id="guide-next">Next</button></div>`;
    const clicked = vi.fn();
    document.querySelector("#guide-next")!.addEventListener("click", clicked);
    (document.querySelector("#guide-next") as HTMLButtonElement).click();
    expect(clicked).toHaveBeenCalled();
  });
});
