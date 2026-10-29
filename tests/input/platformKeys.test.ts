import { afterEach, describe, expect, it } from "vitest";
import { ariaKeys, fmtKeys, isMac, latinKey, setMacForTest } from "../../src/input/platform";

afterEach(() => setMacForTest(null));

describe("fmtKeys", () => {
  it("writes the Command and Option glyphs on macOS", () => {
    setMacForTest(true);
    expect(fmtKeys("Ctrl F")).toBe("⌘ F");
    expect(fmtKeys("Ctrl+Shift+S")).toBe("⌘+Shift+S");
    expect(fmtKeys("Ctrl Alt H")).toBe("⌘ ⌥ H");
    expect(fmtKeys("Hide the items (Ctrl Alt S)")).toBe("Hide the items (⌘ ⌥ S)");
    expect(fmtKeys("Ctrl-click adds")).toBe("⌘-click adds");
  });

  it("keeps Ctrl and Alt elsewhere", () => {
    setMacForTest(false);
    expect(fmtKeys("Ctrl F")).toBe("Ctrl F");
    expect(fmtKeys("Ctrl Alt H")).toBe("Ctrl Alt H");
  });

  it("leaves words that merely contain the names alone", () => {
    setMacForTest(true);
    expect(fmtKeys("Altitude Control")).toBe("Altitude Control");
  });
});

describe("isMac", () => {
  const withNav = (nav: unknown, run: () => void) => {
    const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });
    try {
      run();
    } finally {
      if (had) Object.defineProperty(globalThis, "navigator", had);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  };

  it("reads userAgentData first, then platform", () => {
    withNav({ userAgentData: { platform: "macOS" }, platform: "Win32" }, () => expect(isMac()).toBe(true));
    withNav({ platform: "MacIntel" }, () => expect(isMac()).toBe(true));
    withNav({ platform: "Win32" }, () => expect(isMac()).toBe(false));
    withNav({ userAgentData: { platform: "Windows" }, platform: "MacIntel" }, () => expect(isMac()).toBe(false));
  });
});

describe("latinKey", () => {
  const k = (key: string, code: string, altKey = false) => latinKey({ key, code, altKey });

  it("reads the physical key under a non Latin letter", () => {
    expect(k("у", "KeyE")).toBe("e");
    expect(k("Я", "KeyZ")).toBe("z");
    expect(k("ε", "KeyE")).toBe("e");
    expect(k("ק", "KeyE")).toBe("e");
    expect(k("ث", "KeyE")).toBe("e");
    expect(k("б", "Comma")).toBe(",");
    expect(k("ё", "Backquote")).toBe("`");
    expect(k("۱", "Digit1")).toBe("1");
  });

  it("keeps the typed character on Latin layouts", () => {
    expect(k("a", "KeyQ")).toBe("a");
    expect(k("E", "KeyE")).toBe("e");
    expect(k("&", "Digit1")).toBe("&");
    expect(k("é", "Digit2")).toBe("é");
    expect(k("?", "Slash")).toBe("?");
    expect(k("Escape", "Escape")).toBe("escape");
  });

  it("leaves Alt and AltGr letters unmatched", () => {
    expect(k("ś", "KeyS", true)).toBe("ś");
    expect(k("ж", "KeyS", true)).toBe("ж");
  });

  it("keeps a non Latin key with no Latin twin", () => {
    expect(k("ж", "IntlBackslash")).toBe("ж");
    expect(latinKey({ key: "у" })).toBe("у");
  });
});

describe("ariaKeys", () => {
  it("writes Control on Windows and Linux", () => {
    setMacForTest(false);
    expect(ariaKeys("Ctrl+Shift+Z")).toBe("Control+Shift+Z");
    expect(ariaKeys("Ctrl+Alt+S")).toBe("Control+Alt+S");
    expect(ariaKeys("Ctrl F")).toBe("Control+F");
    expect(ariaKeys("Ctrl+,")).toBe("Control+,");
    expect(ariaKeys("Ctrl+`")).toBe("Control+`");
  });

  it("writes Meta for Ctrl on macOS and keeps the literal Control key", () => {
    setMacForTest(true);
    expect(ariaKeys("Ctrl+Shift+Z")).toBe("Meta+Shift+Z");
    expect(ariaKeys("Ctrl+Alt+S")).toBe("Meta+Alt+S");
    expect(ariaKeys("Control+`")).toBe("Control+`");
  });

  it("names keys by their key values and writes single letters upper case", () => {
    setMacForTest(false);
    expect(ariaKeys("Esc")).toBe("Escape");
    expect(ariaKeys("Del")).toBe("Delete");
    expect(ariaKeys("e")).toBe("E");
    expect(ariaKeys("Shift+h")).toBe("Shift+H");
    expect(ariaKeys("Shift+Home")).toBe("Shift+Home");
    expect(ariaKeys("f2")).toBe("F2");
    expect(ariaKeys("?")).toBe("?");
    expect(ariaKeys("Ctrl++")).toBe("Control++");
  });

  it("space separates alternatives from a hint or a list", () => {
    setMacForTest(false);
    expect(ariaKeys("Ctrl+Z / Ctrl+Y")).toBe("Control+Z Control+Y");
    expect(ariaKeys(["Ctrl+Alt+S", "Ctrl+Shift+1"])).toBe("Control+Alt+S Control+Shift+1");
    setMacForTest(true);
    expect(ariaKeys(["Ctrl+Shift+1"])).toBe("Meta+Shift+1");
  });

  it("leaves out what is no key, and gives nothing for no keys", () => {
    setMacForTest(false);
    expect(ariaKeys("Shift+drag")).toBeUndefined();
    expect(ariaKeys("Arrows / Esc")).toBe("Escape");
    expect(ariaKeys("")).toBeUndefined();
    expect(ariaKeys(undefined)).toBeUndefined();
    expect(ariaKeys([])).toBeUndefined();
  });
});
