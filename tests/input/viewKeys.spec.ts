// Ctrl with a digit row key picks a view, by the key's place rather than what it types, and works from a value box.
// On a layout whose digit row types + or -, Ctrl with that key stays the Interface size key.

import { afterEach, describe, expect, it } from "vitest";
import { installKeymap } from "../../src/input/keymap";
import { resolveShortcut } from "../../src/input/shortcuts";
import { latinKey, matchChord, zoomChord } from "../../src/input/platform";

const VIEWS = ["front", "back", "left", "right", "top", "bottom", "iso"];

// What digit row keys 1 to 7 type without Shift.
const LAYOUTS: Record<string, string[]> = {
  us: ["1", "2", "3", "4", "5", "6", "7"],
  "fr AZERTY": ["&", "é", '"', "'", "(", "-", "è"],
  "be AZERTY": ["&", "é", '"', "'", "(", "§", "è"],
  "cs QWERTZ": ["+", "ě", "š", "č", "ř", "ž", "ý"],
};

type Press = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };
const ctrlDigit = (n: number, key: string, more: Partial<Press> = {}): Press => ({
  key,
  code: `Digit${n}`,
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...more,
});

/** Every window level Ctrl binding that matches by the typed key rather than its place, run ahead of the keymap. */
function keyTextBinding(p: Press): string | null {
  const zoom = zoomChord(p); // ui/interfaceSize.ts, a capture listener that stops the key
  if (zoom) return `interface size ${zoom}`;
  const chord = matchChord(p); // app/keyboard.ts
  if (chord) return chord;
  const k = latinKey(p); // app/keyboard.ts, the file shortcuts and Find
  if (["f", "n", "o", "s", "e"].includes(k) || p.key === ",") return `file ${k}`;
  if (p.key === "k" || p.key === "K") return "palette"; // app/engine.ts
  return null;
}

const installed: (() => void)[] = [];
afterEach(() => {
  installed.splice(0).forEach((off) => off());
  document.body.innerHTML = "";
});

function keymap() {
  const actions: string[] = [];
  installed.push(
    installKeymap(
      (a) => actions.push(a),
      () => "sketch",
    ),
  );
  return actions;
}

function press(target: Element, p: Press) {
  const e = new KeyboardEvent("keydown", { ...p, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe("the view keys", () => {
  it("are Ctrl with 1 to 7 in both contexts, while the bare digits stay the selection modes", () => {
    for (const ctx of ["model", "sketch"] as const) {
      expect([1, 2, 3, 4, 5, 6, 7].map((n) => resolveShortcut(String(n), false, ctx, true))).toEqual(VIEWS);
      expect(resolveShortcut("1", true, ctx, true)).toBeNull();
    }
    expect(resolveShortcut("1", false, "model")).toBe("selmode-faces");
    expect(matchChord(ctrlDigit(1, "!", { shiftKey: true }))).toBe("items");
  });

  it("go by the key's place, so an AZERTY or Czech digit row picks the same views, Cmd too", () => {
    for (const [layout, keys] of Object.entries(LAYOUTS)) {
      const actions = keymap();
      keys.forEach((k, i) => press(document.body, ctrlDigit(i + 1, k)));
      expect([layout, actions]).toEqual([layout, VIEWS]);
      installed.splice(0).forEach((off) => off());
    }
    const actions = keymap();
    press(document.body, ctrlDigit(5, "5", { ctrlKey: false, metaKey: true }));
    expect(actions).toEqual(["top"]);
  });

  it("work from a focused value box, while AltGr and Ctrl+Z there stay the field's", () => {
    const actions = keymap();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const e = press(input, ctrlDigit(2, "2"));
    press(input, ctrlDigit(2, "@", { altKey: true }));
    press(input, { ...ctrlDigit(0, "z"), code: "KeyZ" });
    expect(actions).toEqual(["back"]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("clash with a key text binding only where the digit types + or -, which stays Interface size", () => {
    const clashes = Object.entries(LAYOUTS).flatMap(([layout, keys]) =>
      keys.flatMap((k, i) => {
        const hit = keyTextBinding(ctrlDigit(i + 1, k));
        return hit ? [`${layout} Ctrl+${i + 1}: ${hit}`] : [];
      }),
    );
    expect(clashes).toEqual(["fr AZERTY Ctrl+6: interface size down", "cs QWERTZ Ctrl+1: interface size up"]);
  });
});
