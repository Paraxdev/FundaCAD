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
