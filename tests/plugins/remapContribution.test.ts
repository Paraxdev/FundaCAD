import { afterEach, describe, expect, it } from "vitest";
import { contribute, setGrantLookup } from "../../src/plugins/contrib";
import { DEFAULT_BINDINGS, pointerBindings, type PointerBinding } from "../../src/viewport/navigator/bindings";
import { resolveShortcut } from "../../src/input/shortcuts";

const MIDDLE: PointerBinding[] = [
  { button: "middle", drag: "orbit" },
  { button: "right", click: "menu" },
];
const grants: Record<string, string[]> = {
  "Test.Remap": ["input.remap"],
  "Test.Other": ["input.remap"],
  "Test.Plain": ["ui.panel"],
};
setGrantLookup((id) => grants[id]);

const off: (() => void)[] = [];
afterEach(() => {
  for (const f of off.splice(0)) f();
});

describe("the remap contribution points", () => {
  it("swap the mouse table and the keys in, and removing them restores both", () => {
    off.push(contribute("Test.Remap", { pointerBindings: MIDDLE, keymap: [{ action: "fillet", key: "g" }] }));
    expect(pointerBindings()).toEqual(MIDDLE);
    expect(resolveShortcut("g", false, "model")).toBe("fillet");
    off.pop()!();
    expect(pointerBindings()).toBe(DEFAULT_BINDINGS);
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
  });

  it("refuse a plugin whose manifest lacks input.remap", () => {
    expect(() => contribute("Test.Plain", { pointerBindings: MIDDLE })).toThrow(/input.remap/);
    expect(() => contribute("Test.Unknown", { keymap: [] })).toThrow(/input.remap/);
    expect(pointerBindings()).toBe(DEFAULT_BINDINGS);
  });

  it("refuse a second plugin rather than silently preferring one", () => {
    off.push(contribute("Test.Remap", { pointerBindings: MIDDLE }));
    expect(() => contribute("Test.Other", { pointerBindings: DEFAULT_BINDINGS })).toThrow(/Test.Remap already/);
    expect(pointerBindings()).toEqual(MIDDLE);
  });

  it("keep the default when a contributed table is invalid", () => {
    off.push(contribute("Test.Remap", { pointerBindings: [{ button: "left", drag: "orbit" }] }));
    expect(pointerBindings()).toBe(DEFAULT_BINDINGS);
  });
});
