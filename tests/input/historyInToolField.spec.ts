// FI-2: a tool's value box (sketch/dimInput.ts) holding focus used to keep
// every Ctrl+Z and Ctrl+Y for itself, so undo went dead until someone clicked
// the canvas. Undo and redo put the tool away and reach the document.
import { afterEach, describe, expect, it } from "vitest";
import { DimInput } from "../../src/sketch/dimInput";
import { installKeymap } from "../../src/input/keymap";

const FIELDS = [{ name: "move", label: "Move", kind: "length" as const }];

function press(target: EventTarget, key: string, mods: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
}

describe("undo and redo from a tool's value box", () => {
  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    for (const el of document.querySelectorAll(".dim-input")) el.remove();
  });

  it("Ctrl+Z cancels the tool and undoes the document, and Ctrl+Y then redoes", () => {
    const actions: string[] = [];
    installKeymap((a) => actions.push(a), () => "model");
    const dim = new DimInput();
    let cancelled = 0;
    dim.show(FIELDS, () => {}, () => { cancelled++; dim.hide(); });
    const input = document.querySelector<HTMLInputElement>(".dim-input input")!;
    expect(document.activeElement).toBe(input);

    press(input, "z", { ctrlKey: true });
    expect(cancelled).toBe(1);
    expect(actions).toEqual(["undo"]);
    expect(document.activeElement).not.toBe(input);

    press(document.body, "y", { ctrlKey: true });
    expect(actions).toEqual(["undo", "redo"]);
  });

  it("reaches the document from a box with no cancel of its own", () => {
    const actions: string[] = [];
    installKeymap((a) => actions.push(a), () => "model");
    const dim = new DimInput();
    dim.show(FIELDS, () => {});
    const input = document.querySelector<HTMLInputElement>(".dim-input input")!;
    press(input, "z", { ctrlKey: true, shiftKey: true });
    expect(actions).toEqual(["redo"]);
    expect(document.activeElement).not.toBe(input);
    dim.hide();
  });

  it("still keeps ordinary typing for the box", () => {
    const actions: string[] = [];
    installKeymap((a) => actions.push(a), () => "model");
    const dim = new DimInput();
    dim.show(FIELDS, () => {});
    const input = document.querySelector<HTMLInputElement>(".dim-input input")!;
    press(input, "m");
    press(input, "5");
    expect(actions).toEqual([]);
    expect(document.activeElement).toBe(input);
    dim.hide();
  });
});
