// FI-2: a tool's value box (sketch/dimInput.ts) holding focus used to keep
// every Ctrl+Z and Ctrl+Y for itself, so undo went dead until someone clicked
// the canvas. Typing in the box goes back first; with none left, undo and redo
// put the tool away and reach the document.
import { afterEach, describe, expect, it } from "vitest";
import { DimInput } from "../../src/sketch/dimInput";
import { installKeymap } from "../../src/input/keymap";

const FIELDS = [{ name: "move", label: "Move", kind: "length" as const }];
const off: (() => void)[] = [];

function press(target: EventTarget, key: string, mods: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(ev);
  return ev;
}
function typeInto(input: HTMLInputElement, text: string, inputType = "insertText") {
  input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType }));
  input.value = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
}
function open() {
  const actions: string[] = [];
  off.push(
    installKeymap(
      (a) => actions.push(a),
      () => "model",
    ),
  );
  const dim = new DimInput();
  let cancelled = 0;
  dim.show(
    FIELDS,
    () => {},
    () => {
      cancelled++;
      dim.hide();
    },
  );
  const input = document.querySelector<HTMLInputElement>(".dim-input input")!;
  return { actions, dim, input, cancelled: () => cancelled };
}

describe("Ctrl+Z and Ctrl+Y in a tool's value box", () => {
  afterEach(() => {
    off.splice(0).forEach((f) => f());
    (document.activeElement as HTMLElement | null)?.blur?.();
    for (const el of document.querySelectorAll(".dim-input")) el.remove();
  });

  it("Ctrl+Z cancels the tool and undoes the document, and Ctrl+Y then redoes", () => {
    const { actions, input, cancelled } = open();
    expect(document.activeElement).toBe(input);

    const ev = press(input, "z", { ctrlKey: true });
    expect(cancelled()).toBe(1);
    expect(actions).toEqual(["undo"]);
    expect(document.activeElement).not.toBe(input);
    // Chromium has one undo stack per page, left alone this key would undo another field's typing.
    expect(ev.defaultPrevented).toBe(true);

    press(document.body, "y", { ctrlKey: true });
    expect(actions).toEqual(["undo", "redo"]);
  });

  it("Ctrl+Y with nothing of its own to bring back does the same", () => {
    const { actions, input, cancelled } = open();
    press(input, "y", { ctrlKey: true });
    expect(cancelled()).toBe(1);
    expect(actions).toEqual(["redo"]);
    expect(document.activeElement).not.toBe(input);
  });

  it("reaches the document from a box with no cancel of its own", () => {
    const actions: string[] = [];
    off.push(
      installKeymap(
        (a) => actions.push(a),
        () => "model",
      ),
    );
    const dim = new DimInput();
    dim.show(FIELDS, () => {});
    const input = document.querySelector<HTMLInputElement>(".dim-input input")!;
    press(input, "z", { ctrlKey: true, shiftKey: true });
    expect(actions).toEqual(["redo"]);
    expect(document.activeElement).not.toBe(input);
    dim.hide();
  });

  it("still keeps ordinary typing for the box", () => {
    const { actions, dim, input } = open();
    press(input, "m");
    press(input, "5");
    expect(actions).toEqual([]);
    expect(document.activeElement).toBe(input);
    dim.hide();
  });

  it("typing in the box keeps the key for the field's own undo, then the tool closes and the document has it", () => {
    const { actions, input, cancelled } = open();
    const before = input.value;
    typeInto(input, "7");
    const own = press(input, "z", { ctrlKey: true });
    expect(own.defaultPrevented).toBe(false);
    expect(actions).toEqual([]);
    expect(cancelled()).toBe(0);
    typeInto(input, before, "historyUndo"); // what the browser does after that keydown
    // The field's own redo comes back the same way.
    const again = press(input, "y", { ctrlKey: true });
    expect(again.defaultPrevented).toBe(false);
    expect(actions).toEqual([]);
    typeInto(input, "7", "historyRedo");
    press(input, "z", { ctrlKey: true });
    typeInto(input, before, "historyUndo");
    expect([actions, cancelled()]).toEqual([[], 0]);
    press(input, "z", { ctrlKey: true });
    expect([actions, cancelled()]).toEqual([["undo"], 1]);
  });

  it("a redo with the typing all brought back closes the tool and goes to the document", () => {
    const { actions, input, cancelled } = open();
    const before = input.value;
    typeInto(input, "7");
    typeInto(input, before, "historyUndo");
    typeInto(input, "7", "historyRedo");
    press(input, "y", { ctrlKey: true });
    expect([actions, cancelled()]).toEqual([["redo"], 1]);
  });

  it("a value the tool wrote is not typing, so the document has the key", () => {
    const tracked = open();
    tracked.dim.updateFromCursor({ move: 12 });
    press(tracked.input, "z", { ctrlKey: true });
    expect([tracked.actions, tracked.cancelled()]).toEqual([["undo"], 1]);
    off.splice(0).forEach((f) => f());

    const seeded = open();
    typeInto(seeded.input, "7");
    seeded.dim.seed("move", 3);
    press(seeded.input, "z", { ctrlKey: true });
    expect([seeded.actions, seeded.cancelled()]).toEqual([["undo"], 1]);
  });

  it("taking the typing back leaves a seeded field locked and a cursor field tracking", () => {
    const { dim, input } = open();
    typeInto(input, "7");
    expect(dim.hasTyped()).toBe(true);
    typeInto(input, "", "historyUndo");
    expect(dim.hasTyped()).toBe(false);
    dim.updateFromCursor({ move: 23 });
    expect(input.value).toBe("23");
    dim.seed("move", 31);
    typeInto(input, "47");
    typeInto(input, "31", "historyUndo");
    dim.updateFromCursor({ move: 59 });
    expect(input.value).toBe("31");
  });

  it("typing the text the field already shows locks it as any typing does, only an undo lets it go", () => {
    const { dim, input } = open();
    dim.updateFromCursor({ move: 12.5 });
    typeInto(input, "12.5");
    expect([dim.isUserDriven("move"), dim.hasTyped()]).toEqual([true, true]);
    dim.updateFromCursor({ move: 40.25 });
    expect(input.value).toBe("12.5");

    typeInto(input, "12.5", "historyUndo");
    expect([dim.isUserDriven("move"), dim.hasTyped()]).toEqual([false, false]);
    dim.updateFromCursor({ move: 40.25 });
    expect(input.value).toBe("40.25");
  });

  it("a field undo puts back the value the tool held before the typing, each time", () => {
    const { dim, input } = open();
    let held = -12.5;
    dim.restoresOnUndo(
      "move",
      () => held,
      (v) => {
        held = v;
      },
    );
    dim.updateFromCursor({ move: 12.5 });
    typeInto(input, "7");
    held = 7;
    typeInto(input, "12.5", "historyUndo");
    expect(held).toBe(-12.5);
    typeInto(input, "7", "historyRedo");
    held = 7;
    typeInto(input, "12.5", "historyUndo");
    expect(held).toBe(-12.5);
  });

  it("an undo landing on text that is no value leaves no typed value behind it", () => {
    const { dim, input } = open();
    typeInto(input, "0.7");
    expect(dim.getValue("move")).toBe(0.7);
    typeInto(input, "0.", "historyUndo");
    expect(dim.isUserDriven("move")).toBe(true);
    expect(dim.getValue("move")).toBe(0);
    dim.show([{ name: "move", label: "Move", kind: "length", positive: true }], () => {});
    const again = document.querySelector<HTMLInputElement>(".dim-input input")!;
    typeInto(again, "0.7");
    typeInto(again, "0.", "historyUndo");
    expect(dim.getValue("move")).toBe(null);
  });

  it("an undo stopping on text that is no value does not fall back to a value from before the edit", () => {
    const { dim, input } = open();
    typeInto(input, "25.4");
    document.querySelector<HTMLElement>(".dim-unit")!.click();
    [...document.querySelectorAll<HTMLElement>(".dim-unit-item")].find((i) => i.textContent === "in")!.click();
    expect(input.value).toBe("1");
    typeInto(input, "2");
    typeInto(input, "-", "historyUndo");
    expect([input.value, dim.getValue("move")]).toEqual(["-", null]);
  });

  it("deleting back to the text it started from stays typing", () => {
    const { dim, input } = open();
    typeInto(input, "5");
    typeInto(input, "", "deleteContentBackward");
    dim.updateFromCursor({ move: 9.75 });
    expect([input.value, dim.isUserDriven("move")]).toEqual(["", true]);
  });

  it("a redo of the same text brings the lock back", () => {
    const { dim, input } = open();
    dim.updateFromCursor({ move: 12.5 });
    typeInto(input, "12.5");
    typeInto(input, "12.5", "historyUndo");
    typeInto(input, "12.5", "historyRedo");
    expect([dim.isUserDriven("move"), dim.hasTyped()]).toEqual([true, true]);
  });

  it("the text the field already shows, typed over, is still the field's to undo and redo", () => {
    const { actions, dim, input, cancelled } = open();
    dim.updateFromCursor({ move: 12.5 });
    typeInto(input, "12.5");
    expect(press(input, "z", { ctrlKey: true }).defaultPrevented).toBe(false);
    typeInto(input, "12.5", "historyUndo");
    expect(press(input, "y", { ctrlKey: true }).defaultPrevented).toBe(false);
    typeInto(input, "12.5", "historyRedo");
    expect(actions).toEqual([]);
    expect(press(input, "y", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect([actions, cancelled()]).toEqual([["redo"], 1]);
  });

  describe("with two fields", () => {
    const TWO = [
      { name: "w", label: "W", kind: "length" as const },
      { name: "h", label: "H", kind: "length" as const },
    ];
    function openTwo() {
      const actions: string[] = [];
      off.push(
        installKeymap(
          (a) => actions.push(a),
          () => "model",
        ),
      );
      const dim = new DimInput();
      let cancelled = 0;
      dim.show(
        TWO,
        () => {},
        () => {
          cancelled++;
          dim.hide();
        },
      );
      dim.updateFromCursor({ w: 5.5, h: 3.25 });
      const [w, h] = document.querySelectorAll<HTMLInputElement>(".dim-input input");
      return { actions, dim, w: w!, h: h!, cancelled: () => cancelled };
    }

    it("the document has no key while any field of the box holds typing, whichever has focus", () => {
      const { actions, dim, w, h, cancelled } = openTwo();
      typeInto(w, "7");
      typeInto(h, "8");
      w.focus();
      // The browser takes back H, the last typed, and moves focus there.
      expect(press(w, "z", { ctrlKey: true }).defaultPrevented).toBe(false);
      typeInto(h, "3.25", "historyUndo");
      h.focus();
      expect(press(h, "z", { ctrlKey: true }).defaultPrevented).toBe(false);
      typeInto(w, "5.5", "historyUndo");
      w.focus();
      expect(actions).toEqual([]);
      expect(cancelled()).toBe(0);
      expect(dim.hasTyped()).toBe(false);
      expect(press(w, "z", { ctrlKey: true }).defaultPrevented).toBe(true);
      expect([actions, cancelled()]).toEqual([["undo"], 1]);
    });

    it("redo walks back the same way, then the document has it", () => {
      const { actions, w, h, cancelled } = openTwo();
      typeInto(w, "7");
      typeInto(h, "8");
      typeInto(h, "3.25", "historyUndo");
      typeInto(w, "5.5", "historyUndo");
      expect(press(w, "y", { ctrlKey: true }).defaultPrevented).toBe(false);
      typeInto(w, "7", "historyRedo");
      expect(press(w, "y", { ctrlKey: true }).defaultPrevented).toBe(false);
      typeInto(h, "8", "historyRedo");
      expect(actions).toEqual([]);
      expect(cancelled()).toBe(0);
      expect(press(h, "y", { ctrlKey: true }).defaultPrevented).toBe(true);
      expect([actions, cancelled()]).toEqual([["redo"], 1]);
    });

    it("a tool's write over the other field's typing leaves nothing for the browser", () => {
      const { actions, dim, w, h, cancelled } = openTwo();
      typeInto(w, "7");
      dim.seed("w", 9.5);
      expect(press(h, "z", { ctrlKey: true }).defaultPrevented).toBe(true);
      expect([actions, cancelled()]).toEqual([["undo"], 1]);
    });
  });

  it("any other text field keeps its own undo", () => {
    const { actions } = open();
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    const ev = press(other, "z", { ctrlKey: true });
    expect(actions).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
    other.remove();
  });
});
