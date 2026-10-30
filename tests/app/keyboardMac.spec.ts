// macOS: Command is the primary key, Cmd+Option+H is Hide Others and Cmd+` the window switch, so the panels move to
// Cmd+Shift+1 and 2 there and the console to Control+`. Windows and Linux keep Ctrl+Alt+S and H.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { installKeyboard } from "../../src/app/keyboard";
import { setMacForTest } from "../../src/input/platform";
import { useShellStore } from "../../src/stores/shell";
import { consoleOpen, setConsoleOpen } from "../../src/ui/logStore";
import type { Engine } from "../../src/app/engine";

describe("platform chords", () => {
  // The listeners go on window and stay, so install once.
  beforeAll(() => {
    installKeyboard({
      sketch: { active: false },
      tools: {},
      handleAction: () => {},
      viewport: { clearSelection: () => {}, cycleAreaFilter: () => false },
      toolBusy: () => false,
    } as unknown as Engine);
  });

  afterEach(() => setMacForTest(null));

  const press = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));

  it("toggles the panels on Command+Shift+1 and 2 on macOS, whatever Shift types", () => {
    setMacForTest(true);
    setActivePinia(createPinia());
    const shell = useShellStore();
    const before = shell.itemsShown;
    press({ key: "!", code: "Digit1", metaKey: true, shiftKey: true });
    expect(shell.itemsShown).toBe(!before);
    const hist = shell.historyShown;
    press({ key: "@", code: "Digit2", metaKey: true, shiftKey: true });
    expect(shell.historyShown).toBe(!hist);
  });

  it("leaves Command+Option+H to Hide Others on macOS", () => {
    setMacForTest(true);
    setActivePinia(createPinia());
    const shell = useShellStore();
    const hist = shell.historyShown;
    const ev = new KeyboardEvent("keydown", {
      key: "˙",
      code: "KeyH",
      metaKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    expect(shell.historyShown).toBe(hist);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("opens the console on Control+backtick on macOS and leaves Command+backtick alone", () => {
    setMacForTest(true);
    setConsoleOpen(false);
    press({ key: "`", code: "Backquote", metaKey: true });
    expect(consoleOpen()).toBe(false);
    press({ key: "`", code: "Backquote", ctrlKey: true });
    expect(consoleOpen()).toBe(true);
    setConsoleOpen(false);
  });

  it("toggles the panels on Ctrl+Shift+1 and 2 and the console on Ctrl+backtick on Windows", () => {
    setMacForTest(false);
    setActivePinia(createPinia());
    const shell = useShellStore();
    const before = shell.itemsShown;
    press({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
    expect(shell.itemsShown).toBe(!before);
    const hist = shell.historyShown;
    press({ key: "@", code: "Digit2", ctrlKey: true, shiftKey: true });
    expect(shell.historyShown).toBe(!hist);
    setConsoleOpen(false);
    press({ key: "`", code: "Backquote", ctrlKey: true });
    expect(consoleOpen()).toBe(true);
    setConsoleOpen(false);
  });

  it("still follows the typed letter on a layout where it sits on another physical key", () => {
    setActivePinia(createPinia());
    const shell = useShellStore();
    const before = shell.itemsShown;
    press({ key: "s", code: "KeyR", ctrlKey: true, altKey: true });
    expect(shell.itemsShown).toBe(!before);
  });

  it("leaves AltGr alone on Windows, where it types a letter on the S key", () => {
    setMacForTest(false);
    setActivePinia(createPinia());
    const shell = useShellStore();
    const before = shell.itemsShown;
    const hist = shell.historyShown;
    const ev = new KeyboardEvent("keydown", {
      key: "ś",
      code: "KeyS",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    expect(shell.itemsShown).toBe(before);
    expect(ev.defaultPrevented).toBe(false);
    const evH = new KeyboardEvent("keydown", {
      key: "ħ",
      code: "KeyH",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(evH);
    expect(shell.historyShown).toBe(hist);
    expect(evH.defaultPrevented).toBe(false);
  });

  it("matches the typed letter on Dvorak and Colemak on Windows", () => {
    setMacForTest(false);
    setActivePinia(createPinia());
    const shell = useShellStore();
    const before = shell.itemsShown;
    press({ key: "s", code: "KeyO", ctrlKey: true, altKey: true });
    expect(shell.itemsShown).toBe(!before);
    const hist = shell.historyShown;
    press({ key: "h", code: "KeyD", ctrlKey: true, altKey: true });
    expect(shell.historyShown).toBe(!hist);
  });
});
