// The on-canvas value box, as a thing sitting over the model.
//
// It hangs next to whatever is being dragged and it is a SIBLING of the canvas
// rather than a child, so any part of it under the cursor is a part of the
// canvas the tool stops hearing about. Both tests here are that hazard: one
// that the box gets out of the way of a drag it is not part of, and one that
// its own buttons still have marks in them, which they lost to a flex rule.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DimInput } from "../../src/sketch/dimInput";
import { iconElement } from "../../src/ui/icons";

/** happy-dom has no PointerEvent constructor in every version, and nothing here
 *  reads a pointer property, only the target, so a plain bubbling Event is
 *  the honest stand-in. */
function press(type: string, target: EventTarget) {
  target.dispatchEvent(new Event(type, { bubbles: true }));
}

let dim: DimInput;

beforeEach(() => {
  dim = new DimInput();
});
afterEach(() => {
  dim.dispose();
});

const root = () => document.querySelector<HTMLElement>(".dim-input")!;

describe("DimInput hit testing", () => {
  it("drops out of the way of a drag that started somewhere else", () => {
    dim.show([{ name: "radius", label: "R" }], () => {});
    expect(root().style.pointerEvents).toBe("");

    press("pointerdown", document.body);
    // Without this the cursor crossing the box sends pointermove to the box,
    // and the tool listening on the canvas simply stops being told the drag is
    // still happening, it reads as the value sticking, then jumping.
    expect(root().style.pointerEvents).toBe("none");

    press("pointerup", document.body);
    expect(root().style.pointerEvents).toBe("");
  });

  it("does not step aside for a press on itself", () => {
    dim.show([{ name: "radius", label: "R" }], () => {}, () => {});
    const ok = root().querySelector<HTMLElement>(".dim-ok")!;
    press("pointerdown", ok);
    // Turning the box click-through here would mean the confirm button could
    // not be pressed a second time.
    expect(root().style.pointerEvents).toBe("");
  });

  it("gets out of the way for the press that ARMS a tool, not just later ones", () => {
    // The fluent entry is one gesture: the press lands on the canvas, the tool
    // arms inside that same pointerdown and shows the box, and the drag follows
    // without the button ever coming up. So the box has to honour a press that
    // happened before it existed.
    press("pointerdown", document.body);
    dim.show([{ name: "radius", label: "R" }], () => {});
    expect(root().style.pointerEvents).toBe("none");

    press("pointerup", document.body);
    expect(root().style.pointerEvents).toBe("");
  });

  it("still lets a tool hold it click-through on its own account", () => {
    // Tools that are still deciding WHERE to place something keep the box
    // click-through for the whole placement, which must survive a press/release
    // cycle clearing the drag flag.
    dim.show([{ name: "radius", label: "R" }], () => {});
    dim.setClickThrough(true);
    press("pointerdown", document.body);
    press("pointerup", document.body);
    expect(root().style.pointerEvents).toBe("none");
  });
});

describe("iconElement", () => {
  it("carries the class that stops it collapsing in a flex slot", () => {
    // `.icon { flex: 0 0 auto }`. Without it the confirm/cancel marks laid out
    // 0px wide inside their `display: inline-flex` buttons and the heads-up box
    // showed two empty squares, the paths were present and correct throughout,
    // which is why it survived every test that asserted on markup.
    const svg = iconElement("check", 13);
    expect(svg.getAttribute("class")).toBe("icon");
    expect(svg.getAttribute("data-icon")).toBe("check");
    expect(svg.querySelector("path")).not.toBeNull();
  });

  it("puts one in each of the box's buttons", () => {
    dim.show([{ name: "radius", label: "R" }], () => {}, () => {});
    expect(root().querySelector(".dim-ok .icon")).not.toBeNull();
    expect(root().querySelector(".dim-no .icon")).not.toBeNull();
  });
});
