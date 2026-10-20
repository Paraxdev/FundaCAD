// macOS: Command is the primary key, and Option turns a letter into another
// character (Option+S types "ß"), so the panel shortcuts read the physical key.
import { describe, it, expect, beforeAll } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { installKeyboard } from "../../src/app/keyboard";
import { useShellStore } from "../../src/stores/shell";
import type { Engine } from "../../src/app/engine";

describe("Command and Option shortcuts", () => {
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

  const press = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));

  it("toggles the items panel on Command+Option+S, whatever character Option makes", () => {
    setActivePinia(createPinia());
    const shell = useShellStore();
    const before = shell.itemsShown;
    press({ key: "ß", code: "KeyS", metaKey: true, altKey: true });
    expect(shell.itemsShown).toBe(!before);
    const hist = shell.historyShown;
    press({ key: "˙", code: "KeyH", metaKey: true, altKey: true });
    expect(shell.historyShown).toBe(!hist);
  });

  it("still follows the typed letter on a layout where it sits on another physical key", () => {
    setActivePinia(createPinia());
    const shell = useShellStore();
    const before = shell.itemsShown;
    press({ key: "s", code: "KeyR", ctrlKey: true, altKey: true });
    expect(shell.itemsShown).toBe(!before);
  });
});
