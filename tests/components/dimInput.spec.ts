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

describe("DimInput's optional switch", () => {
  // The mode a tool has to offer WHILE the value is being set. Extrude's
  // Symmetric is the first, and the reason it is a button at all is that a bare
  // letter cannot be claimed: the field is focused for the whole drag and it
  // takes spelled-out units, and "millimeters", "inches" and "mils" all carry
  // the obvious key.
  const toggle = () => root().querySelector<HTMLButtonElement>(".dim-toggle");

  it("is absent unless the tool asked for one", () => {
    dim.show([{ name: "distance", label: "D" }], () => {});
    expect(toggle()).toBeNull();
  });

  it("reports a press and reflects the state it lands in", () => {
    const seen: boolean[] = [];
    dim.show([{ name: "distance", label: "D" }], () => {}, undefined, {
      label: "Symmetric", title: "both ways", initial: false,
      onChange: (on) => seen.push(on),
    });
    const b = toggle()!;
    expect(b.textContent).toBe("Symmetric");
    expect(b.classList.contains("on")).toBe(false);

    press("pointerdown", b);
    expect(seen).toEqual([true]);
    expect(b.classList.contains("on")).toBe(true);

    press("pointerdown", b);
    expect(seen).toEqual([true, false]);
    expect(b.classList.contains("on")).toBe(false);
  });

  it("opens in the state a re-opened feature was saved with", () => {
    dim.show([{ name: "distance", label: "D" }], () => {}, undefined, {
      label: "Symmetric", title: "both ways", initial: true, onChange: () => {},
    });
    expect(toggle()!.classList.contains("on")).toBe(true);
  });

  it("follows the tool when the state changes some other way, without calling back", () => {
    // Alt+S goes to the tool, not to the button, so the two would disagree
    // about a mode the user is looking at unless the tool can push it here.
    const seen: boolean[] = [];
    dim.show([{ name: "distance", label: "D" }], () => {}, undefined, {
      label: "Symmetric", title: "both ways", initial: false,
      onChange: (on) => seen.push(on),
    });
    dim.setToggle(true);
    expect(toggle()!.classList.contains("on")).toBe(true);
    expect(seen).toEqual([]); // a callback here would be a loop

    // and a press from THERE goes the other way, rather than repeating `true`
    press("pointerdown", toggle()!);
    expect(seen).toEqual([false]);
  });

  it("does not survive into the next tool's showing", () => {
    dim.show([{ name: "distance", label: "D" }], () => {}, undefined, {
      label: "Symmetric", title: "both ways", initial: true, onChange: () => {},
    });
    expect(toggle()).not.toBeNull();
    dim.show([{ name: "radius", label: "R" }], () => {});
    expect(toggle()).toBeNull();
    // and setToggle on a box that has none is a no-op rather than a crash
    expect(() => dim.setToggle(true)).not.toThrow();
  });
});

describe("DimInput seed and takeOver", () => {
  // The contract a re-opened feature rests on. `seed` fills a field AND locks
  // it, so a hand that merely happens to be moving cannot rewrite a saved
  // value; `takeOver` is the one thing that unlocks it, for a deliberate drag
  // on the handle that owns the field.
  //
  // Extrude is why these are tested. It seeded the distance when re-opening a
  // committed extrude and had no grabbable arrow, so the lock had nothing to
  // release it: the arrow was drawn, the depth could not be dragged, and the
  // only way to change it was to retype. Both halves below are load-bearing,
  // and the first is why the second cannot simply be "never lock".
  const value = () => root().querySelector<HTMLInputElement>("input")!.value;

  it("a seeded field ignores the cursor", () => {
    dim.show([{ name: "distance", label: "D" }], () => {});
    dim.seed("distance", 40);
    expect(dim.isUserDriven("distance")).toBe(true);

    dim.updateFromCursor({ distance: 7 });
    expect(value()).toBe("40"); // the saved depth, not the passing cursor
  });

  it("a drag on the handle takes it back", () => {
    dim.show([{ name: "distance", label: "D" }], () => {});
    dim.seed("distance", 40);

    dim.takeOver("distance");
    expect(dim.isUserDriven("distance")).toBe(false);
    dim.updateFromCursor({ distance: 52.5 });
    // The number beside the arrow has to follow the arrow. Otherwise the
    // geometry says one thing, the box says another, and nothing on screen
    // says which of the two will be committed.
    expect(value()).toBe("52.5");
    expect(dim.getValue("distance")).toBe(52.5);
  });

  it("control: typing re-locks it, and the cursor is shut out again", () => {
    // takeOver is not a one-way door. A drag hands control to the cursor; the
    // next keystroke has to hand it back, or a typed value would be overwritten
    // by the next mouse movement, which is the bug seed exists to prevent.
    dim.show([{ name: "distance", label: "D" }], () => {});
    dim.takeOver("distance");
    const input = root().querySelector<HTMLInputElement>("input")!;
    input.value = "12";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(dim.isUserDriven("distance")).toBe(true);
    dim.updateFromCursor({ distance: 99 });
    expect(value()).toBe("12");
  });
});
