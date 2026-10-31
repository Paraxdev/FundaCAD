// The on-canvas value box, as a thing sitting over the model.
//
// It hangs next to whatever is being dragged and it is a SIBLING of the canvas
// rather than a child, so any part of it under the cursor is a part of the
// canvas the tool stops hearing about. Both tests here are that hazard: one
// that the box gets out of the way of a drag it is not part of, and one that
// its own buttons still have marks in them, which they lost to a flex rule.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DimInput, type DimDocument } from "../../src/sketch/dimInput";
import { classifyExprInput } from "../../src/params/engine";
import type { CadDocument } from "../../src/types";
import { icon, iconElement } from "../../src/ui/icons";
import { escapeClaimed } from "../../src/ui/escapeClaim";

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

describe("DimInput focus on the frame after show", () => {
  function showThenFocus(other: HTMLElement) {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    document.body.appendChild(other);
    dim.show([{ name: "radius", label: "R" }], () => {});
    other.focus();
    frames.forEach((f) => f(0));
    vi.unstubAllGlobals();
  }

  it("leaves a text field that took focus meanwhile", () => {
    const field = document.createElement("input");
    showThenFocus(field);
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it("takes focus back from a button a press landed on", () => {
    const button = document.createElement("button");
    showThenFocus(button);
    expect(root().contains(document.activeElement)).toBe(true);
    button.remove();
  });
});

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
    dim.show(
      [{ name: "radius", label: "R" }],
      () => {},
      () => {},
    );
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

  it("lets a click through a box centred on the drawing, and is clickable again on the next show", () => {
    // The circle's diameter box sits on the radius midpoint, so at a small radius the placing click lands on it.
    dim.show([{ name: "radius", label: "R" }], () => {});
    dim.positionCentred(143, 87);
    expect(root().style.pointerEvents).toBe("none");
    dim.show([{ name: "radius", label: "R" }], () => {});
    expect(root().style.pointerEvents).toBe("");
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

  it("is hidden from screen readers, so a field or button reads its own name with no stray image", () => {
    const svg = iconElement("check", 13);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(icon("check")).toMatch(/^<svg aria-hidden="true" focusable="false" /);
  });

  it("puts one in each of the box's buttons", () => {
    dim.show(
      [{ name: "radius", label: "R" }],
      () => {},
      () => {},
    );
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
      label: "Symmetric",
      title: "both ways",
      initial: false,
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
      label: "Symmetric",
      title: "both ways",
      initial: true,
      onChange: () => {},
    });
    expect(toggle()!.classList.contains("on")).toBe(true);
  });

  it("follows the tool when the state changes some other way, without calling back", () => {
    // Alt+S goes to the tool, not to the button, so the two would disagree
    // about a mode the user is looking at unless the tool can push it here.
    const seen: boolean[] = [];
    dim.show([{ name: "distance", label: "D" }], () => {}, undefined, {
      label: "Symmetric",
      title: "both ways",
      initial: false,
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
      label: "Symmetric",
      title: "both ways",
      initial: true,
      onChange: () => {},
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

describe("DimInput confirm and cancel", () => {
  // Both act on the press and take the box away, so the release that follows
  // lands on the canvas underneath. It used to be read there as a click on the
  // model, which selected the body behind the cross and raised the Move gizmo.
  const canvasHearing = () => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const heard: string[] = [];
    canvas.addEventListener("pointerup", () => heard.push("pointerup"));
    canvas.addEventListener("click", () => heard.push("click"));
    return { canvas, heard };
  };

  for (const which of [".dim-ok", ".dim-no"]) {
    it(`${which} keeps its release off the canvas behind it`, () => {
      const { canvas, heard } = canvasHearing();
      let closed = 0;
      const close = () => {
        closed++;
        dim.hide();
      };
      dim.show([{ name: "radius", label: "R" }], close, close);
      press("pointerdown", root().querySelector<HTMLElement>(which)!);
      expect(closed).toBe(1);
      press("pointerup", canvas);
      press("click", canvas);
      expect(heard).toEqual([]);
      canvas.remove();
    });
  }

  it("lets the next press through", async () => {
    const { canvas, heard } = canvasHearing();
    dim.show(
      [{ name: "radius", label: "R" }],
      () => dim.hide(),
      () => dim.hide(),
    );
    press("pointerdown", root().querySelector<HTMLElement>(".dim-no")!);
    press("pointerup", canvas);
    press("click", canvas);
    await new Promise((r) => setTimeout(r, 0));
    press("pointerup", canvas);
    press("click", canvas);
    expect(heard).toEqual(["pointerup", "click"]);
    canvas.remove();
  });
});

describe("DimInput from the keyboard alone", () => {
  const key = (k: string, shift = false) =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }),
    );
  const typeInto = (text: string) => {
    const i = document.activeElement as HTMLInputElement;
    i.value = text;
    i.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const ok = () => root().querySelector<HTMLButtonElement>(".dim-ok")!;
  const no = () => root().querySelector<HTMLButtonElement>(".dim-no")!;

  it("types width and height, Tabs to Confirm and confirms with its click", () => {
    const commits: Record<string, number>[] = [];
    dim.show(
      [
        { name: "w", label: "Width" },
        { name: "h", label: "Height" },
      ],
      (v) => commits.push(v),
      () => {},
    );
    typeInto("30");
    key("Tab");
    typeInto("20");
    key("Tab");
    expect(document.activeElement).toBe(ok());
    // Enter on a button is the browser's click, so the box leaves the key alone and keeps it from the window.
    const heard: string[] = [];
    const hear = (e: KeyboardEvent) => heard.push(e.key);
    window.addEventListener("keydown", hear);
    expect(key("Enter")).toBe(true);
    window.removeEventListener("keydown", hear);
    expect(heard).toEqual([]);
    expect(commits).toEqual([]);
    ok().click();
    expect(commits).toEqual([{ w: 30, h: 20 }]);
  });

  it("lets Tab off Cancel leave the box, and Cancel answers its click", () => {
    let cancelled = 0;
    dim.show(
      [{ name: "r", label: "R" }],
      () => {},
      () => cancelled++,
    );
    key("Tab");
    key("Tab");
    expect(document.activeElement).toBe(no());
    expect(key("Tab")).toBe(true);
    no().click();
    expect(cancelled).toBe(1);
  });

  it("confirms once for a press and the click that follows its release", () => {
    let commits = 0;
    dim.show([{ name: "r", label: "R" }], () => commits++);
    press("pointerdown", ok());
    press("pointerup", ok());
    ok().click();
    expect(commits).toBe(1);
  });
});

describe("DimInput hidden fields", () => {
  it("hides a field in place, keeps what was typed and Tab skips it", () => {
    dim.show(
      [
        { name: "distance", label: "D" },
        { name: "taper", label: "Angle" },
        { name: "depth", label: "H" },
      ],
      () => {},
    );
    const inputs = [...root().querySelectorAll<HTMLInputElement>("input")];
    inputs[0]!.value = "4.7";
    dim.setFieldHidden("taper", true);
    expect(inputs[1]!.closest("label")!.style.display).toBe("none");
    expect(dim.getRaw("distance")).toBe("4.7");

    inputs[0]!.focus();
    inputs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(inputs[2]);

    dim.setFieldHidden("taper", false);
    expect(inputs[1]!.closest("label")!.style.display).toBe("");
  });
});

describe("what is typed is read, or refused out loud", () => {
  const input = (i = 0) => root().querySelectorAll<HTMLInputElement>("input")[i]!;
  const type = (text: string, i = 0) => {
    input(i).value = text;
    input(i).dispatchEvent(new Event("input", { bubbles: true }));
  };
  const enter = (i = 0) => input(i).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const problem = () => root().querySelector(".dim-problem")?.textContent ?? null;

  it("keeps the sign, the comma and the arithmetic", () => {
    const got: Record<string, number>[] = [];
    dim.show([{ name: "move", label: "Move" }], (v) => got.push(v));
    for (const [text, want] of [
      ["-2", -2],
      ["20,5", 20.5],
      ["-(5+2)", -7],
      ["\u22123", -3],
    ] as const) {
      type(text);
      enter();
      expect(got.pop()!.move).toBeCloseTo(want);
    }
  });

  it("does not confirm text that is not a value, and says why", () => {
    const commit = vi.fn();
    dim.show([{ name: "move", label: "Move" }], commit);
    type("abc");
    enter();
    expect(commit).not.toHaveBeenCalled();
    expect(problem()).toBe('Move: "abc" is not a number');
    expect(dim.getValue("move")).toBeNull();

    type("1,000");
    enter();
    expect(problem()).toMatch(/ambiguous/);

    type("3");
    expect(problem()).toBeNull();
    enter();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("refuses a negative where only a positive means anything, instead of flipping it", () => {
    const commit = vi.fn();
    dim.show([{ name: "radius", label: "R", positive: true }], commit);
    type("-2");
    expect(dim.getValue("radius")).toBeNull();
    enter();
    expect(commit).not.toHaveBeenCalled();
    expect(problem()).toBe("R must be more than 0");
  });

  it("marks the refused field invalid and points it at the reason, and clears both once the value reads", () => {
    dim.show(
      [
        { name: "width", label: "W", positive: true },
        { name: "height", label: "H" },
      ],
      () => {},
    );
    const state = () =>
      [0, 1].map((i) => ({
        invalid: input(i).getAttribute("aria-invalid"),
        error: input(i).getAttribute("aria-errormessage"),
        describedBy: input(i).getAttribute("aria-describedby"),
      }));
    const [w, h] = [0, 1].map((i) => input(i).getAttribute("aria-describedby")!);
    type("-2");
    const id = root().querySelector(".dim-problem")!.id;
    const refused = state();
    type("2");
    expect({ chips: [w, h].every((c) => /^dim-unit-\d+$/.test(c!)), id, refused, cleared: state() }).toEqual({
      chips: true,
      id: expect.stringMatching(/^dim-problem-\d+$/),
      refused: [
        { invalid: "true", error: id, describedBy: `${w} ${id}` },
        { invalid: null, error: null, describedBy: h },
      ],
      cleared: [
        { invalid: null, error: null, describedBy: w },
        { invalid: null, error: null, describedBy: h },
      ],
    });
  });

  it("holds a count to whole numbers and its floor", () => {
    const commit = vi.fn();
    dim.show([{ name: "count", label: "N", kind: "count", integer: true, atLeast: 3 }], commit);
    type("2.5");
    enter();
    expect(problem()).toBe("N must be a whole number");
    type("2");
    enter();
    expect(problem()).toBe("N must be at least 3");
    type("12abc");
    enter();
    expect(problem()).toMatch(/^N: /);
    expect(commit).not.toHaveBeenCalled();
  });

  it("leaves a field the tool reads itself alone", () => {
    const commit = vi.fn();
    dim.show([{ name: "size", label: "Size", kind: "count", free: true }], commit);
    type("M5");
    enter();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(problem()).toBeNull();
  });

  it("does not judge a value the cursor wrote", () => {
    const commit = vi.fn();
    dim.show([{ name: "radius", label: "R", positive: true }], commit);
    dim.updateFromCursor({ radius: -1 });
    enter();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("lets a tool refuse the confirm with its own reason", () => {
    dim.show([{ name: "move", label: "Move" }], () => dim.flag("Click an arrow first"));
    type("2");
    enter();
    expect(problem()).toBe("Click an arrow first");
  });
});

describe("DimInput's choice on a field's name", () => {
  // A round face's size reads as a radius, a diameter or an offset, picked from
  // a menu on the name or typed ahead of the number.
  const input = () => root().querySelector<HTMLInputElement>("input")!;
  const tag = () => root().querySelector<HTMLElement>(".dim-name")!;
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const menuRows = () => [...document.querySelectorAll<HTMLButtonElement>(".dim-unit-menu .dim-unit-item")];
  const options = [
    { id: "radius", label: "R", word: "Radius" },
    { id: "diameter", label: "Diameter", icon: "diameter", word: "Diameter" },
    { id: "offset", label: "Offset", word: "Offset" },
  ];
  const read = (raw: string) => {
    const m = /^r(?=\d)/.exec(raw);
    if (m) return { choice: "radius", text: raw.slice(1) };
    return /^[-+]/.test(raw) ? { choice: "offset", text: raw } : null;
  };
  const show = (seen: [string, boolean][], withRead = true) =>
    dim.show(
      [
        {
          name: "size",
          label: "Diameter",
          icon: "diameter",
          kind: "length",
          choices: {
            options,
            chosen: "diameter",
            ...(withRead ? { read } : {}),
            onChoose: (id, typed) => seen.push([id, typed]),
          },
        },
      ],
      () => {},
    );

  it("is a plain name unless the field has choices", () => {
    dim.show([{ name: "size", label: "D" }], () => {});
    expect(tag().tagName).toBe("SPAN");
    expect(tag().querySelector("[data-icon='caretDown']")).toBeNull();
  });

  it("opens a menu of the choices, the chosen one marked, and reports a pick", () => {
    const seen: [string, boolean][] = [];
    show(seen);
    expect(tag().tagName).toBe("BUTTON");
    expect(tag().title).toBe("Diameter");
    press("pointerdown", tag());
    expect(menuRows().map((r) => r.textContent)).toEqual(["Radius", "Diameter", "Offset"]);
    expect(menuRows().map((r) => r.classList.contains("active"))).toEqual([false, true, false]);

    press("pointerdown", menuRows()[0]!);
    expect(seen).toEqual([["radius", false]]);
    expect(dim.choiceOf("size")).toBe("radius");
    expect(tag().textContent).toBe("R");
    expect(menuRows()).toEqual([]);
  });

  it("takes the choice typed ahead of the number and reads the number alone", () => {
    const seen: [string, boolean][] = [];
    show(seen);
    type("r2.5");
    expect(seen).toEqual([["radius", true]]);
    expect(dim.getValue("size")).toBeCloseTo(2.5);
    expect(input().value).toBe("r2.5");

    type("-0.5");
    expect(seen.at(-1)).toEqual(["offset", true]);
    expect(dim.getValue("size")).toBeCloseTo(-0.5);
    expect(tag().textContent).toBe("Offset");
  });

  it("control: without a reader the same text is not a value", () => {
    const seen: [string, boolean][] = [];
    show(seen, false);
    type("r2.5");
    expect(seen).toEqual([]);
    expect(dim.getValue("size")).toBeNull();
  });

  it("follows the tool without calling back", () => {
    const seen: [string, boolean][] = [];
    show(seen);
    dim.setChoice("size", "offset");
    expect(seen).toEqual([]);
    expect(dim.choiceOf("size")).toBe("offset");
    expect(tag().textContent).toBe("Offset");
    expect(tag().querySelector("[data-icon='caretDown']")).not.toBeNull();
  });

  it("leaves the unit menu converting through the shared popup", () => {
    show([]);
    type("10");
    press("pointerdown", root().querySelector<HTMLElement>(".dim-field .dim-unit:not(.dim-choice)")!);
    const inch = menuRows().find((r) => r.textContent === "in")!;
    press("pointerdown", inch);
    expect(Number(input().value)).toBeCloseTo(0.39, 2);
  });
});

describe("DimInput names", () => {
  it("names each input with its field label, and the two buttons", () => {
    dim.show(
      [
        { name: "depth", label: "D" },
        { name: "angle", label: "Taper angle", icon: "angle", kind: "angle" },
      ],
      () => {},
      () => {},
    );
    const inputs = [...root().querySelectorAll("input")];
    expect(inputs.map((i) => i.getAttribute("aria-label"))).toEqual(["D", "Taper angle"]);
    expect([...root().querySelectorAll<HTMLElement>(".dim-field")].map((f) => f.dataset.field)).toEqual([
      "depth",
      "angle",
    ]);
    expect(root().querySelector(".dim-ok")!.getAttribute("aria-label")).toBe("Confirm");
    expect(root().querySelector(".dim-no")!.getAttribute("aria-label")).toBe("Cancel");
  });

  it("renames the input when the field label changes", () => {
    dim.show([{ name: "r", label: "R" }], () => {});
    dim.setFieldLabel("r", "Diameter");
    expect(root().querySelector("input")!.getAttribute("aria-label")).toBe("Diameter");
  });

  it("is a group named by its shown fields, renamed as they change", () => {
    dim.show(
      [
        { name: "w", label: "Width" },
        { name: "h", label: "Height" },
      ],
      () => {},
    );
    expect(root().getAttribute("role")).toBe("group");
    expect(root().getAttribute("aria-label")).toBe("Width, Height");
    dim.setFieldLabel("w", "Length");
    expect(root().getAttribute("aria-label")).toBe("Length, Height");
    dim.setFieldHidden("h", true);
    expect(root().getAttribute("aria-label")).toBe("Length");
    dim.setFieldHidden("w", true);
    expect(root().getAttribute("aria-label")).toBe("Values");
  });

  it("is described by the tool's prompt and a hidden line of its keys, on every showing", () => {
    const prompt = document.createElement("span");
    prompt.id = "prompt";
    prompt.textContent = "Drag the second corner";
    document.body.appendChild(prompt);
    const described = () =>
      root()
        .getAttribute("aria-describedby")!
        .split(" ")
        .map((id) => document.getElementById(id));
    try {
      for (let showing = 0; showing < 2; showing++) {
        dim.show([{ name: "r", label: "R" }], () => {});
        const [first, help] = described();
        expect(first).toBe(prompt);
        expect(help!.hidden).toBe(true);
        expect(root().contains(help!)).toBe(true);
        expect(help!.textContent).toBe("Enter applies, Escape cancels, Tab moves on, Alt+Down opens the field's list");
        dim.hide();
      }
      dim.show([{ name: "n", label: "Count", kind: "count" }], () => {});
      expect(described()[1]!.textContent).toBe("Enter applies, Escape cancels, Tab moves on");
    } finally {
      prompt.remove();
    }
  });

  it("builds each input as NumberField's, in the box's own row with no well", () => {
    dim.show(
      [
        { name: "w", label: "Width" },
        { name: "n", label: "Count", kind: "count" },
      ],
      () => {},
    );
    const [w, n] = [...root().querySelectorAll<HTMLInputElement>(".dim-field input")];
    for (const i of [w!, n!]) {
      expect(i.type).toBe("text");
      expect(i.getAttribute("inputmode")).toBe("text");
      expect(i.getAttribute("autocomplete")).toBe("off");
      expect(i.getAttribute("spellcheck")).toBe("false");
      expect(i.hasAttribute("title")).toBe(false);
    }
    const width = root().querySelector<HTMLElement>(".dim-field[data-field='w']")!;
    expect([...width.children].map((c) => c.tagName)).toEqual(["SPAN", "INPUT", "BUTTON"]);
    expect(root().querySelector(".ui-field, .ui-number-field")).toBeNull();
    expect(root().querySelector(".dim-field[data-field='n'] .dim-unit")).toBeNull();
    expect(n!.hasAttribute("aria-describedby")).toBe(false);
  });

  it("describes each input by its unit chip, which names the unit it shows", () => {
    dim.show(
      [
        { name: "w", label: "Width" },
        { name: "a", label: "Angle", kind: "angle" },
      ],
      () => {},
    );
    const chips = [...root().querySelectorAll<HTMLElement>(".dim-field .dim-unit")];
    const inputs = [...root().querySelectorAll<HTMLInputElement>(".dim-field input")];
    expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(["Unit, mm", "Unit, °"]);
    expect(chips.map((c) => c.textContent)).toEqual(["mm", "°"]);
    expect(inputs.map((i) => document.getElementById(i.getAttribute("aria-describedby")!))).toEqual(chips);
    expect(new Set(chips.map((c) => c.id)).size).toBe(2);
    const chip = chips[0]!;
    expect(chip.classList.contains("ui-unit-chip")).toBe(true);
    expect([chip.getAttribute("role"), chip.getAttribute("aria-haspopup"), chip.title]).toEqual([
      "combobox",
      "listbox",
      "Change unit",
    ]);
    expect(chip.tabIndex).toBe(-1);
    inputs[0]!.value = "2 in";
    inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(chip.getAttribute("aria-label")).toBe("Unit, in");
    expect(chip.dataset.value).toBe("in");
  });

  it("marks the unit chip open while its menu is up, and names the menu it opened", () => {
    dim.show([{ name: "w", label: "Width" }], () => {});
    const chip = root().querySelector<HTMLElement>(".dim-field .dim-unit")!;
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    press("pointerdown", chip);
    const menu = document.querySelector<HTMLElement>(".dim-unit-menu")!;
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(chip.getAttribute("aria-controls")).toBe(menu.id);
    const cm = [...menu.querySelectorAll<HTMLElement>(".dim-unit-item")].find((r) => r.textContent === "cm")!;
    press("pointerdown", cm);
    expect(document.querySelector(".dim-unit-menu")).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(chip.hasAttribute("aria-controls")).toBe(false);
    expect(chip.getAttribute("aria-label")).toBe("Unit, cm");
  });

  it("gives each box its own help id", () => {
    const other = new DimInput();
    try {
      dim.show([{ name: "r", label: "R" }], () => {});
      other.show([{ name: "d", label: "D" }], () => {});
      const ids = [...document.querySelectorAll<HTMLElement>(".dim-input")].map((r) =>
        r.getAttribute("aria-describedby"),
      );
      expect(new Set(ids).size).toBe(2);
      expect(document.querySelectorAll(".dim-input span[hidden]").length).toBe(2);
    } finally {
      other.dispose();
    }
  });
});

describe("DimInput lists by keyboard", () => {
  const key = (target: EventTarget, k: string, mods: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });
    target.dispatchEvent(e);
    return e;
  };
  const menu = () => document.querySelector<HTMLElement>(".dim-unit-menu");
  const rows = () => [...menu()!.querySelectorAll<HTMLElement>(".dim-unit-item")];
  const inputs = () => [...root().querySelectorAll<HTMLInputElement>("input")];
  const chipOf = (i: number) => root().querySelectorAll<HTMLElement>(".dim-field .dim-unit:not(.dim-choice)")[i]!;
  const activeRow = (anchor: HTMLElement) => document.getElementById(anchor.getAttribute("aria-activedescendant")!);
  const showWidth = () => {
    dim.show(
      [
        { name: "w", label: "Width" },
        { name: "h", label: "Height" },
      ],
      () => {},
      () => {},
    );
    inputs()[0]!.focus();
  };
  const choiceField = (options: { id: string; label: string; word: string }[], onChoose: (id: string) => void) =>
    dim.show(
      [
        {
          name: "size",
          label: "Diameter",
          kind: "length",
          choices: { options, chosen: "diameter", onChoose: (id) => onChoose(id) },
        },
      ],
      () => {},
    );

  it("opens the unit list on Alt+Down from the field, a listbox of options with the shown unit selected", () => {
    showWidth();
    expect(key(inputs()[0]!, "ArrowDown", { altKey: true }).defaultPrevented).toBe(true);
    const chip = chipOf(0);
    expect([menu()!.getAttribute("role"), menu()!.getAttribute("aria-label")]).toEqual(["listbox", "Unit"]);
    expect(rows().every((r) => r.getAttribute("role") === "option" && r.tabIndex === -1)).toBe(true);
    const selected = rows().filter((r) => r.getAttribute("aria-selected") === "true");
    expect(selected.map((r) => r.textContent)).toEqual([chip.dataset.value]);
    expect(document.activeElement).toBe(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(activeRow(chip)).toBe(selected[0]);
    expect(selected[0]!.classList.contains("is-active")).toBe(true);
    // A field with no choices has no list to its left.
    expect(key(chip, "ArrowLeft").defaultPrevented).toBe(false);
    expect(menu()!.getAttribute("aria-label")).toBe("Unit");
  });

  it("control: Alt+Down in a count field, which has no unit, opens nothing", () => {
    dim.show([{ name: "n", label: "Count", kind: "count" }], () => {});
    expect(key(inputs()[0]!, "ArrowDown", { altKey: true }).defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it("moves through the options with the arrows, Home and End, and Enter converts back in the field", () => {
    showWidth();
    inputs()[0]!.value = "10";
    inputs()[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    key(inputs()[0]!, "ArrowDown", { altKey: true });
    const chip = chipOf(0);
    key(chip, "End");
    expect(activeRow(chip)).toBe(rows().at(-1));
    key(chip, "Home");
    key(chip, "ArrowUp");
    expect(activeRow(chip)).toBe(rows()[0]);
    const inch = rows().findIndex((r) => r.textContent === "in");
    for (let i = 0; i < inch; i++) key(chip, "ArrowDown");
    expect(activeRow(chip)!.textContent).toBe("in");
    expect(key(chip, "Enter").defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(inputs()[0]);
    expect(Number(inputs()[0]!.value)).toBeCloseTo(0.39, 2);
    expect([chip.getAttribute("aria-label"), chip.hasAttribute("aria-activedescendant")]).toEqual(["Unit, in", false]);
  });

  it("closes the list on Escape back to the field, claiming the key from the tool", async () => {
    const cancelled = vi.fn();
    const heard: boolean[] = [];
    const tool = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(escapeClaimed());
    };
    window.addEventListener("keydown", tool, true);
    try {
      dim.show([{ name: "w", label: "Width" }], () => {}, cancelled);
      inputs()[0]!.focus();
      key(inputs()[0]!, "ArrowDown", { altKey: true });
      expect(key(chipOf(0), "Escape").defaultPrevented).toBe(true);
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(inputs()[0]);

      // A list a press opened leaves the focus in the field, whose Escape closes it the same way.
      press("pointerdown", chipOf(0));
      expect(document.activeElement).toBe(inputs()[0]);
      key(inputs()[0]!, "Escape");
      expect(menu()).toBeNull();
      expect(heard).toEqual([true, true]);
      expect(cancelled).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 0));
      key(inputs()[0]!, "Escape");
      expect(heard.at(-1)).toBe(false);
    } finally {
      window.removeEventListener("keydown", tool, true);
    }
  });

  it("opens on Enter, Space and the arrows on the chip", () => {
    showWidth();
    const chip = chipOf(0);
    for (const k of ["Enter", " ", "ArrowDown", "ArrowUp"]) {
      chip.focus();
      expect(key(chip, k).defaultPrevented).toBe(true);
      expect([k, menu() !== null, document.activeElement === chip]).toEqual([k, true, true]);
      key(chip, "Escape");
    }
    expect(menu()).toBeNull();
    expect(key(chip, "ArrowDown", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it("answers a click with no press, as a screen reader sends, on the chip and on an option", () => {
    showWidth();
    const chip = chipOf(0);
    press("click", chip);
    expect(document.activeElement).toBe(chip);
    expect(menu()).not.toBeNull();
    press("click", chip);
    expect(menu()).toBeNull();
    press("click", chip);
    press(
      "click",
      rows().find((r) => r.textContent === "cm")!,
    );
    expect(menu()).toBeNull();
    expect(chip.getAttribute("aria-label")).toBe("Unit, cm");
  });

  it("control: the click a Space sends on its release does not close the list it opened", () => {
    showWidth();
    const chip = chipOf(0);
    chip.focus();
    key(chip, " ");
    const up = new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true });
    chip.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    press("click", chip);
    expect(menu()).not.toBeNull();
  });

  it("lets Tab on the chip move on from its field and Shift+Tab return to its input, closing the list", () => {
    showWidth();
    key(inputs()[0]!, "ArrowDown", { altKey: true });
    expect(key(chipOf(0), "Tab").defaultPrevented).toBe(true);
    expect([menu(), document.activeElement]).toEqual([null, inputs()[1]]);
    key(inputs()[1]!, "ArrowDown", { altKey: true });
    expect(key(chipOf(1), "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect([menu(), document.activeElement]).toEqual([null, inputs()[1]]);
  });

  it("makes the choice tag a named combobox, and Left and Right step between its list and the unit's", () => {
    const seen: string[] = [];
    choiceField(
      [
        { id: "radius", label: "R", word: "Radius" },
        { id: "diameter", label: "Diameter", word: "Diameter" },
      ],
      (id) => seen.push(id),
    );
    const tag = root().querySelector<HTMLElement>(".dim-choice")!;
    expect(["role", "aria-haspopup", "aria-label"].map((a) => tag.getAttribute(a))).toEqual([
      "combobox",
      "listbox",
      "Measure, Diameter",
    ]);
    inputs()[0]!.focus();
    key(inputs()[0]!, "ArrowDown", { altKey: true });
    expect(document.activeElement).toBe(chipOf(0));
    key(chipOf(0), "ArrowLeft");
    expect([document.activeElement, menu()!.getAttribute("aria-label")]).toEqual([tag, "Measure"]);
    expect(activeRow(tag)!.textContent).toBe("Diameter");
    key(tag, "ArrowRight");
    expect([document.activeElement, menu()!.getAttribute("aria-label")]).toEqual([chipOf(0), "Unit"]);
    key(chipOf(0), "ArrowLeft");
    key(tag, "ArrowUp");
    key(tag, " ");
    expect(seen).toEqual(["radius"]);
    expect([menu(), document.activeElement, tag.getAttribute("aria-label")]).toEqual([
      null,
      inputs()[0],
      "Measure, Radius",
    ]);
  });

  it("lets Tab on the tag go into its input and Shift+Tab off the first field's tag leave the box", () => {
    choiceField([{ id: "diameter", label: "Diameter", word: "Diameter" }], () => {});
    const tag = root().querySelector<HTMLElement>(".dim-choice")!;
    tag.focus();
    expect(key(tag, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(inputs()[0]);
    tag.focus();
    expect(key(tag, "Tab", { shiftKey: true }).defaultPrevented).toBe(false);
  });
});

describe("DimInput reads parameter names", () => {
  const doc: CadDocument = {
    parameters: { width: 40 },
    paramDefs: { width: { expr: "40", value: 40, unit: "mm" } },
    features: [],
  };
  const source: DimDocument = {
    classifyTargetExpr: (bound, pending, raw, kind) => classifyExprInput(doc, raw, kind, bound, pending),
  };
  const input = () => root().querySelector<HTMLInputElement>("input")!;
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const enter = () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const problem = () => root().querySelector(".dim-problem")?.textContent ?? null;
  let commit: ReturnType<typeof vi.fn<(values: Record<string, number>) => void>>;

  beforeEach(() => {
    dim.dispose();
    dim = new DimInput(() => source);
    commit = vi.fn();
    dim.show([{ name: "depth", label: "Depth", positive: true }], commit);
  });

  it("reads a parameter name as its value", () => {
    type("width");
    expect(problem()).toBeNull();
    expect(dim.getValue("depth")).toBe(40);
    expect(dim.exprOf("depth")).toEqual({ expr: "width" });
    enter();
    expect(commit).toHaveBeenCalledWith({ depth: 40 });
  });

  it("reads an expression with names", () => {
    type("width / 4");
    expect(dim.getValue("depth")).toBe(10);
    expect(dim.exprOf("depth")).toEqual({ expr: "width / 4" });
    enter();
    expect(commit).toHaveBeenCalledWith({ depth: 10 });
  });

  it("reads name = expr and keeps the new name for the tool to create", () => {
    type("rib = width / 4");
    expect(problem()).toBeNull();
    expect(dim.getValue("depth")).toBe(10);
    expect(dim.exprOf("depth")).toEqual({ expr: "width / 4", name: "rib" });
    enter();
    expect(commit).toHaveBeenCalledWith({ depth: 10 });
  });

  it("refuses an unknown name and says which one", () => {
    type("widht / 4");
    enter();
    expect(commit).not.toHaveBeenCalled();
    expect(problem()).toBe('Depth: no parameter named "widht"');
    expect(dim.exprOf("depth")).toBeNull();
  });

  it("refuses name = expr for a name that already exists, as the History rows do", () => {
    type("width = 12");
    enter();
    expect(commit).not.toHaveBeenCalled();
    expect(problem()).toBe('Depth: "width" already exists');
  });

  it("still judges a named value by the field's rule", () => {
    type("width - 50");
    enter();
    expect(commit).not.toHaveBeenCalled();
    expect(problem()).toBe("Depth must be more than 0");
  });

  it("keeps plain numbers and maths in the field's own unit, with no expression to bind", () => {
    type("1,000");
    enter();
    expect(commit).not.toHaveBeenCalled();
    expect(problem()).toMatch(/ambiguous/);
    type("10 + 5");
    expect(dim.getValue("depth")).toBe(15);
    expect(dim.exprOf("depth")).toBeNull();
  });
});
