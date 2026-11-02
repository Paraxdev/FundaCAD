// A tool's value box: Ctrl+Z takes back the box's own typing, then does what menu Undo does, and the tool stays open.
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

  it("an untouched box sends the key to the document and the tool stays open with focus", () => {
    const { actions, input, cancelled } = open();
    const ev = press(input, "z", { ctrlKey: true });
    expect(actions).toEqual(["undo"]);
    expect(cancelled()).toBe(0);
    expect(input.isConnected).toBe(true);
    expect(document.activeElement).toBe(input);
    // Chromium has one undo stack per page, left alone this key would undo another field's typing.
    expect(ev.defaultPrevented).toBe(true);
    press(input, "y", { ctrlKey: true });
    press(input, "z", { ctrlKey: true, shiftKey: true });
    expect(actions).toEqual(["undo", "redo", "redo"]);
    expect(cancelled()).toBe(0);
  });

  it("typing in the box keeps the key for the field's own undo, then the document has it", () => {
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
    press(input, "z", { ctrlKey: true });
    expect(actions).toEqual(["undo"]);
    expect(cancelled()).toBe(0);
  });

  it("a value the tool wrote is not typing, so the document has the key", () => {
    const { actions, dim, input } = open();
    dim.updateFromCursor({ move: 12 });
    press(input, "z", { ctrlKey: true });
    expect(actions).toEqual(["undo"]);
    typeInto(input, "7");
    dim.seed("move", 3);
    press(input, "z", { ctrlKey: true });
    expect(actions).toEqual(["undo", "undo"]);
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
    const { actions, dim, input } = open();
    dim.updateFromCursor({ move: 12.5 });
    typeInto(input, "12.5");
    expect(press(input, "z", { ctrlKey: true }).defaultPrevented).toBe(false);
    typeInto(input, "12.5", "historyUndo");
    expect(press(input, "y", { ctrlKey: true }).defaultPrevented).toBe(false);
    typeInto(input, "12.5", "historyRedo");
    expect(actions).toEqual([]);
    expect(press(input, "y", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(actions).toEqual(["redo"]);
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
      dim.show(
        TWO,
        () => {},
        () => dim.hide(),
      );
      dim.updateFromCursor({ w: 5.5, h: 3.25 });
      const [w, h] = document.querySelectorAll<HTMLInputElement>(".dim-input input");
      return { actions, dim, w: w!, h: h! };
    }

    it("the document has no key while any field of the box holds typing, whichever has focus", () => {
      const { actions, dim, w, h } = openTwo();
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
      expect(dim.hasTyped()).toBe(false);
      expect(press(w, "z", { ctrlKey: true }).defaultPrevented).toBe(true);
      expect(actions).toEqual(["undo"]);
    });

    it("redo walks back the same way, then the document has it", () => {
      const { actions, w, h } = openTwo();
      typeInto(w, "7");
      typeInto(h, "8");
      typeInto(h, "3.25", "historyUndo");
      typeInto(w, "5.5", "historyUndo");
      expect(press(w, "y", { ctrlKey: true }).defaultPrevented).toBe(false);
      typeInto(w, "7", "historyRedo");
      expect(press(w, "y", { ctrlKey: true }).defaultPrevented).toBe(false);
      typeInto(h, "8", "historyRedo");
      expect(actions).toEqual([]);
      expect(press(h, "y", { ctrlKey: true }).defaultPrevented).toBe(true);
      expect(actions).toEqual(["redo"]);
    });

    it("a tool's write over the other field's typing leaves nothing for the browser", () => {
      const { actions, dim, w, h } = openTwo();
      typeInto(w, "7");
      dim.seed("w", 9.5);
      expect(press(h, "z", { ctrlKey: true }).defaultPrevented).toBe(true);
      expect(actions).toEqual(["undo"]);
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
