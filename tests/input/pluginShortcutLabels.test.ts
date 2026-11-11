// A plugin's keymap label is a getter, and the conflict lines read it again after a language switch.

import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import de from "../../src/i18n/locales/de.json";
import en from "../../src/i18n/locales/en.json";
import {
  activeShortcuts,
  checkShortcut,
  resetUserShortcuts,
  setShortcutOverrides,
  shortcutHudGroups,
  shortcutLabel,
} from "../../src/input/shortcuts";

afterEach(async () => {
  setShortcutOverrides([]);
  resetUserShortcuts();
  await setLanguage("system");
});

let ring = "Radial ring";
const plugin = {
  action: "radial-ring",
  key: "f",
  context: "model" as const,
  get label() {
    return ring;
  },
};
const said = (line: string, first: string, second: string) =>
  line.replaceAll("{first}", first).replaceAll("{second}", second);
const conflictLines = () => shortcutHudGroups().find((g) => g.id === "conflicts")?.rows ?? [];

describe("a plugin row's name after a language switch", () => {
  it("the Conflicts line reads the getter again", async () => {
    ring = "Radial ring";
    expect(setShortcutOverrides([plugin])).toHaveLength(1);
    expect(conflictLines()).toEqual([{ key: "F", label: said(en["shortcuts.conflict"], "Radial ring", "Fillet") }]);
    ring = "Radialring";
    await setLanguage("de");
    expect(conflictLines()).toEqual([
      { key: "F", label: said(de["shortcuts.conflict"], "Radialring", de["tool.fillet"]) },
    ]);
  });

  it("a problem found from the cache names the plugin action in the new words", async () => {
    ring = "Radial ring";
    setShortcutOverrides([plugin]);
    activeShortcuts();
    ring = "Radialring";
    await setLanguage("de");
    const p = checkShortcut({ action: "line", key: "f", context: "model" });
    expect(p && "conflict" in p ? shortcutLabel(p.conflict) : null).toBe("Radialring");
  });

  it("a plugin row without a label shows its action, and a core row keeps its own name", async () => {
    setShortcutOverrides([{ action: "radial-ring", key: "j", shift: true, context: "sketch" }]);
    const rows = activeShortcuts();
    expect(shortcutLabel(rows.find((r) => r.action === "radial-ring")!)).toBe("radial-ring");
    await setLanguage("de");
    expect(shortcutLabel(rows.find((r) => r.action === "fillet")!)).toBe(de["tool.fillet"]);
  });

  it("a core action a plugin moves to another context keeps its name in the new language", async () => {
    setShortcutOverrides([{ action: "fillet", key: "j", context: "global" }]);
    const moved = activeShortcuts().find((r) => r.action === "fillet" && r.context === "global")!;
    expect(shortcutLabel(moved)).toBe(en["tool.fillet"]);
    await setLanguage("de");
    expect(shortcutLabel(moved)).toBe(de["tool.fillet"]);
  });
});
