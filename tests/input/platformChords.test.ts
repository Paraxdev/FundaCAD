import { afterEach, describe, expect, it } from "vitest";
import {
  CHORDS,
  chordHint,
  chordKeys,
  comboKey,
  fmtKeys,
  matchChord,
  setMacForTest,
  type ChordId,
} from "../../src/input/platform";
import { checkRow, shortcutRows } from "../../src/input/shortcuts";

afterEach(() => setMacForTest(null));

describe("platform chords on Windows and Linux", () => {
  it("keeps Ctrl+Alt+S and Ctrl+Alt+H, the keys the harness presses", () => {
    setMacForTest(false);
    expect(matchChord({ key: "s", code: "KeyS", ctrlKey: true, altKey: true })).toBe("items");
    expect(matchChord({ key: "h", code: "KeyH", ctrlKey: true, altKey: true })).toBe("history");
    expect(chordHint("items")).toBe("Ctrl+Alt+S");
    expect(chordHint("history")).toBe("Ctrl+Alt+H");
  });

  it("also takes Ctrl+Shift+1 and 2 by the physical key, whatever Shift types", () => {
    setMacForTest(false);
    expect(matchChord({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true })).toBe("items");
    expect(matchChord({ key: "@", code: "Digit2", ctrlKey: true, shiftKey: true })).toBe("history");
    // AZERTY types the digit under Shift, the code is the same
    expect(matchChord({ key: "2", code: "Digit2", ctrlKey: true, shiftKey: true })).toBe("history");
  });

  it("opens the console on Ctrl+backtick, typed or on the Backquote key", () => {
    setMacForTest(false);
    expect(matchChord({ key: "`", code: "Backquote", ctrlKey: true })).toBe("console");
    expect(matchChord({ key: "^", code: "Backquote", ctrlKey: true })).toBe("console");
    expect(chordHint("console")).toBe("Ctrl+`");
  });

  it("leaves AltGr letters, bare digits and Ctrl+1 alone", () => {
    setMacForTest(false);
    expect(matchChord({ key: "ś", code: "KeyS", ctrlKey: true, altKey: true })).toBeNull();
    expect(matchChord({ key: "1", code: "Digit1", ctrlKey: true })).toBeNull();
    expect(matchChord({ key: "!", code: "Digit1", shiftKey: true })).toBeNull();
    expect(matchChord({ key: "`", code: "Backquote" })).toBeNull();
  });
});

describe("platform chords on macOS", () => {
  it("moves Items and History to Cmd+Shift+1 and 2, since Cmd+Option+H is Hide Others", () => {
    setMacForTest(true);
    expect(matchChord({ key: "!", code: "Digit1", metaKey: true, shiftKey: true })).toBe("items");
    expect(matchChord({ key: "@", code: "Digit2", metaKey: true, shiftKey: true })).toBe("history");
    expect(matchChord({ key: "˙", code: "KeyH", metaKey: true, altKey: true })).toBeNull();
    expect(matchChord({ key: "ß", code: "KeyS", metaKey: true, altKey: true })).toBeNull();
    expect(chordKeys("items")).toBe("Ctrl+Shift+1");
    expect(chordHint("items")).toBe("⌘+Shift+1");
    expect(chordHint("history")).toBe("⌘+Shift+2");
  });

  it("opens the console on Control+backtick and leaves Cmd+backtick to the window switch", () => {
    setMacForTest(true);
    expect(matchChord({ key: "`", code: "Backquote", ctrlKey: true })).toBe("console");
    expect(matchChord({ key: "`", code: "Backquote", metaKey: true })).toBeNull();
    expect(chordHint("console")).toBe("⌃+`");
  });
});

describe("fmtKeys Control", () => {
  it("writes the caret glyph for the literal Control key on macOS only, and leaves the word alone", () => {
    setMacForTest(true);
    expect(fmtKeys("Control+`")).toBe("⌃+`");
    expect(fmtKeys("Control points")).toBe("Control points");
    setMacForTest(false);
    expect(fmtKeys("Control+`")).toBe("Control+`");
  });
});

describe("comboKey", () => {
  it("reads the digit row by code under Ctrl or Cmd, and the key otherwise", () => {
    expect(comboKey({ key: "!", code: "Digit1", ctrlKey: true })).toBe("1");
    expect(comboKey({ key: "&", code: "Digit1", metaKey: true })).toBe("1");
    expect(comboKey({ key: "!", code: "Digit1" })).toBe("!");
    expect(comboKey({ key: "z", code: "KeyZ", ctrlKey: true })).toBe("z");
    expect(comboKey({ key: "я", code: "KeyZ", ctrlKey: true })).toBe("z");
  });
});

describe("the shortcut editor refuses the chords", () => {
  it("reserves every chord without Alt on both platforms", () => {
    const id = shortcutRows()[0]!.id;
    for (const mac of [false, true]) {
      for (const [name, chords] of Object.entries(CHORDS) as [ChordId, { pc: string[]; mac: string[] }][]) {
        for (const chord of mac ? chords.mac : chords.pc) {
          const parts = chord.split("+");
          if (parts.includes("Alt")) continue;
          const key = parts.pop()!.toLowerCase();
          const problem = checkRow(id, { key, ctrl: true, shift: parts.includes("Shift") });
          expect(problem, `${name} ${chord}`).toHaveProperty("reserved");
        }
      }
    }
  });
});
