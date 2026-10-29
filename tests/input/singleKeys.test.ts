// Single key shortcuts (Accessibility settings, WCAG 2.1.4): off, a character key without Ctrl or Cmd binds
// nothing, so voice dictation and screen reader browse mode cannot start a tool. Chords and named keys stay.

import { afterEach, describe, expect, it } from "vitest";
import { resolveShortcut, setShortcutOverrides, toolChar } from "../../src/input/shortcuts";
import { setA11yPref } from "../../src/ui/a11yPrefs";

afterEach(() => {
  setA11yPref("singleKeys", true);
  setShortcutOverrides([]);
});

type Press = [key: string, shift: boolean, context: "model" | "sketch", ctrl?: boolean];

const characters: Press[] = [
  ["e", false, "model"],
  ["h", true, "model"],
  ["1", false, "model"],
  ["?", false, "model"],
  ["l", false, "sketch"],
  ["p", true, "sketch"],
  ["?", false, "sketch"],
];

const named: Press[] = [
  ["arrowleft", false, "model"],
  ["arrowleft", true, "sketch"],
  ["home", false, "model"],
  ["home", true, "sketch"],
  ["f6", false, "model"],
  ["u", false, "model", true],
  ["b", false, "model", true],
];

const resolve = ([key, shift, context, ctrl]: Press) => resolveShortcut(key, shift, context, ctrl);

describe("Single key shortcuts", () => {
  it("on, every character key and every named key or chord resolves", () => {
    for (const p of [...characters, ...named]) expect(resolve(p), p.join(" ")).not.toBeNull();
  });

  it("off, letters, Shift letters, digits and the question mark resolve to nothing", () => {
    setA11yPref("singleKeys", false);
    for (const p of characters) expect(resolve(p), p.join(" ")).toBeNull();
  });

  it("off, arrows, Home, F keys and Ctrl chords still resolve to the same action", () => {
    const before = named.map(resolve);
    setA11yPref("singleKeys", false);
    expect(named.map(resolve)).toEqual(before);
  });

  it("off, a key a plugin moved to a letter is silenced too, one moved to a chord is not", () => {
    setShortcutOverrides([
      { action: "fillet", key: "g" },
      { action: "extrude", key: "j", ctrl: true },
    ]);
    setA11yPref("singleKeys", false);
    expect(resolveShortcut("g", false, "model")).toBeNull();
    expect(resolveShortcut("j", false, "model", true)).toBe("extrude");
  });
});

type Key = { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };
const press = (k: Key) => toolChar({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...k });

describe("a running tool's own character keys", () => {
  const keys: Key[] = [
    { key: "f", code: "KeyF" },
    { key: "G", code: "KeyG", shiftKey: true },
    { key: "а", code: "KeyF" },
    { key: "х", code: "BracketLeft" },
    { key: "]", code: "BracketRight" },
    { key: "+", code: "Equal", shiftKey: true },
    { key: "-", code: "Minus" },
    { key: "f", code: "KeyF", ctrlKey: true },
    { key: "ArrowUp", code: "ArrowUp" },
    { key: "Escape", code: "Escape" },
  ];

  it("on, read as the Latin key of the layout, Shift held or not, and named keys read as nothing", () => {
    expect(keys.map(press)).toEqual(["f", "g", "f", "[", "]", "+", "-", "f", "", ""]);
  });

  it("off, only a Ctrl or Cmd chord still reads", () => {
    setA11yPref("singleKeys", false);
    expect(keys.map(press)).toEqual(["", "", "", "", "", "", "", "f", "", ""]);
    expect(press({ key: "c", code: "KeyC", metaKey: true })).toBe("c");
  });
});
