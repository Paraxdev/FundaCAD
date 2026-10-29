// The Interface size keys (decision D2): Ctrl or Cmd with Plus, Minus and 0, kept out of the shortcut table, reserved
// against remaps, and the palette commands that do the same.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMacForTest, zoomChord } from "../../src/input/platform";
import { SHORTCUTS, checkRow, checkShortcut, type Shortcut } from "../../src/input/shortcuts";

const announce = vi.hoisted(() => vi.fn());
vi.mock("../../src/ui/announce", () => ({ announce }));

type Ev = Parameters<typeof zoomChord>[0];
const ev = (key: string, mods: Partial<Ev> = {}, code = ""): Ev => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

afterEach(() => setMacForTest(null));

describe("zoomChord", () => {
  it("reads Ctrl on Windows and Linux, and not Cmd", () => {
    setMacForTest(false);
    expect(zoomChord(ev("=", { ctrlKey: true }, "Equal"))).toBe("up");
    expect(zoomChord(ev("+", { ctrlKey: true }, "BracketRight"))).toBe("up");
    expect(zoomChord(ev("-", { ctrlKey: true }, "Minus"))).toBe("down");
    expect(zoomChord(ev("0", { ctrlKey: true }, "Digit0"))).toBe("reset");
    expect(zoomChord(ev("=", { metaKey: true }, "Equal"))).toBe(null);
    expect(zoomChord(ev("=", { ctrlKey: true, metaKey: true }, "Equal"))).toBe(null);
  });

  it("reads Cmd on macOS, and not Ctrl", () => {
    setMacForTest(true);
    expect(zoomChord(ev("=", { metaKey: true }, "Equal"))).toBe("up");
    expect(zoomChord(ev("-", { metaKey: true }, "Minus"))).toBe("down");
    expect(zoomChord(ev("0", { metaKey: true }, "Digit0"))).toBe("reset");
    expect(zoomChord(ev("0", { ctrlKey: true }, "Digit0"))).toBe(null);
  });

  it("takes the numpad, and the 0 key where the layout shifts it", () => {
    setMacForTest(false);
    expect(zoomChord(ev("+", { ctrlKey: true }, "NumpadAdd"))).toBe("up");
    expect(zoomChord(ev("-", { ctrlKey: true }, "NumpadSubtract"))).toBe("down");
    expect(zoomChord(ev("0", { ctrlKey: true }, "Numpad0"))).toBe("reset");
    expect(zoomChord(ev("à", { ctrlKey: true }, "Digit0"))).toBe("reset");
  });

  it("leaves Ctrl+Insert on the numpad 0 to copy", () => {
    setMacForTest(false);
    expect(zoomChord(ev("Insert", { ctrlKey: true }, "Numpad0"))).toBe(null);
  });

  it("does nothing with Alt held, or with no modifier", () => {
    setMacForTest(false);
    expect(zoomChord(ev("=", { ctrlKey: true, altKey: true }, "Equal"))).toBe(null);
    expect(zoomChord(ev("-", {}, "Minus"))).toBe(null);
    expect(zoomChord(ev("0", {}, "Digit0"))).toBe(null);
  });
});

describe("the shortcut table", () => {
  const chordOf = (s: Shortcut) => (s.ctrl ? zoomChord(ev(s.key, { ctrlKey: true })) : null);

  it("binds none of the Interface size chords", () => {
    setMacForTest(false);
    expect(SHORTCUTS.filter((s) => chordOf(s) !== null)).toEqual([]);
  });

  it("the guard catches a row that took one", () => {
    setMacForTest(false);
    const row: Shortcut = { key: "0", ctrl: true, action: "fit", context: "global", label: "Fit" };
    expect(chordOf(row)).toBe("reset");
  });

  it("refuses them as a remap or a person's own key", () => {
    for (const key of ["=", "+", "-", "0"]) {
      expect(checkShortcut({ action: "fit", key, ctrl: true })).toEqual({ reserved: "Interface size" });
      expect(checkRow("fit", { key, ctrl: true })).toEqual({ reserved: "Interface size" });
    }
    expect(checkShortcut({ action: "fit", key: "+", ctrl: true, shift: true })).toEqual({ reserved: "Interface size" });
  });
});

describe("the key listener and the palette", () => {
  let stored: Map<string, string>;

  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    });
    announce.mockClear();
    setMacForTest(false);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function load() {
    vi.resetModules();
    const prefs = await import("../../src/ui/a11yPrefs");
    const size = await import("../../src/ui/interfaceSize");
    return { ...prefs, ...size };
  }

  const keydown = (key: string, code: string, mods: Partial<Ev> = { ctrlKey: true }) => {
    const e = { ...ev(key, mods, code), preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    return e as unknown as KeyboardEvent & {
      preventDefault: ReturnType<typeof vi.fn>;
      stopImmediatePropagation: ReturnType<typeof vi.fn>;
    };
  };
  const said = (text: string) => [text, "polite", { key: "interface-size" }];

  it("steps the size, keeps the chord from the page and says the new size", async () => {
    const m = await load();
    const e = keydown("=", "Equal");
    expect(m.interfaceSizeKey(e)).toBe(true);
    expect(m.a11yPrefs().interfaceSize).toBe(110);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
    expect(announce).toHaveBeenLastCalledWith(...said("Interface size 110 percent"));
    m.interfaceSizeKey(keydown("-", "Minus"));
    m.interfaceSizeKey(keydown("-", "Minus"));
    expect(m.a11yPrefs().interfaceSize).toBe(90);
    m.interfaceSizeKey(keydown("0", "Digit0"));
    expect(m.a11yPrefs().interfaceSize).toBe(100);
    expect(announce).toHaveBeenLastCalledWith(...said("Interface size 100 percent"));
  });

  it("says when the size is already at an end", async () => {
    const m = await load();
    m.setA11yPref("interfaceSize", m.INTERFACE_SIZE_MAX);
    m.changeInterfaceSize("up");
    expect(announce).toHaveBeenLastCalledWith(...said(`Interface size ${m.INTERFACE_SIZE_MAX} percent, the largest`));
    m.setA11yPref("interfaceSize", 80);
    m.changeInterfaceSize("down");
    expect(announce).toHaveBeenLastCalledWith(...said("Interface size 80 percent, the smallest"));
  });

  it("lets every other key through untouched", async () => {
    const m = await load();
    const e = keydown("s", "KeyS");
    expect(m.interfaceSizeKey(e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(m.a11yPrefs().interfaceSize).toBe(100);
  });

  it("lists the three palette commands in View with their keys, and none repeats as the last command", async () => {
    await load();
    const { allCommands } = await import("../../src/ui/commands");
    const { NON_REPEATABLE } = await import("../../src/app/actionTables");
    const ids = ["interface-size-up", "interface-size-down", "interface-size-reset"];
    const cmds = allCommands().filter((c) => ids.includes(c.id));
    expect(cmds.map((c) => [c.id, c.label, c.group, c.key])).toEqual([
      ["interface-size-up", "Larger Interface", "View", "Ctrl+Plus"],
      ["interface-size-down", "Smaller Interface", "View", "Ctrl+Minus"],
      ["interface-size-reset", "Reset Interface Size", "View", "Ctrl+0"],
    ]);
    expect(ids.filter((id) => !NON_REPEATABLE.has(id))).toEqual([]);
  });

  it("the palette actions step and reset the size", async () => {
    const m = await load();
    const { createActions } = await import("../../src/app/actions");
    const { createPinia, setActivePinia } = await import("pinia");
    setActivePinia(createPinia());
    const run = createActions({ sketch: { active: false }, lastAction: "extrude" } as never);
    run("interface-size-up");
    run("interface-size-up");
    expect(m.a11yPrefs().interfaceSize).toBe(125);
    run("interface-size-down");
    expect(m.a11yPrefs().interfaceSize).toBe(110);
    run("interface-size-reset");
    expect(m.a11yPrefs().interfaceSize).toBe(100);
  });
});
