// macOS: Command is the primary key, and Option turns a letter into another
// character (Option+S types "ß"), so the panel shortcuts read the physical key.
import { describe, it, expect } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { installKeyboard } from "../../src/app/keyboard";
import { useShellStore } from "../../src/stores/shell";
import type { Engine } from "../../src/app/engine";

describe("Command and Option shortcuts", () => {
  it("toggles the items panel on Command+Option+S, whatever character Option makes", () => {
    setActivePinia(createPinia());
    const shell = useShellStore();
    installKeyboard({
      sketch: { active: false },
      tools: {},
      handleAction: () => {},
      viewport: { clearSelection: () => {}, cycleAreaFilter: () => false },
      toolBusy: () => false,
    } as unknown as Engine);
    const before = shell.itemsShown;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ß", code: "KeyS", metaKey: true, altKey: true, bubbles: true }));
    expect(shell.itemsShown).toBe(!before);
    const hist = shell.historyShown;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "˙", code: "KeyH", metaKey: true, altKey: true, bubbles: true }));
    expect(shell.historyShown).toBe(!hist);
  });
});
