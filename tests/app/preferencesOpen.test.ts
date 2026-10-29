import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createActions } from "../../src/app/actions";
import { NON_REPEATABLE } from "../../src/app/actionTables";
import { allCommands } from "../../src/ui/commands";
import { useDialogStore } from "../../src/stores/dialogs";
import type { Engine } from "../../src/app/engine";

const e = { sketch: { active: false }, lastAction: "extrude" } as unknown as Engine;

beforeEach(() => setActivePinia(createPinia()));

describe("the palette's Preferences, Accessibility Settings and Keyboard shortcuts", () => {
  it("are listed once each, and neither repeats as the last command", () => {
    const ids = ["preferences", "accessibility-settings", "shortcut-help"];
    const cmds = allCommands().filter((c) => ids.includes(c.id));
    expect(cmds.map((c) => [c.id, c.label, c.group, c.key])).toEqual([
      ["preferences", "Preferences…", "Edit", "Ctrl+,"],
      ["accessibility-settings", "Accessibility Settings…", "Edit", undefined],
      ["shortcut-help", "Keyboard Shortcuts…", "Help", "?"],
    ]);
    expect(ids.filter((id) => !NON_REPEATABLE.has(id))).toEqual([]);
  });

  it("the action opens Preferences and closes the shortcuts dialog under it", () => {
    const d = useDialogStore();
    d.shortcuts = true;
    createActions(e)("preferences");
    expect([d.preferences, d.shortcuts, e.lastAction]).toEqual([true, false, "extrude"]);
    createActions(e)("preferences");
    expect([d.preferences, d.shortcuts]).toEqual([true, false]);
  });

  it("Accessibility Settings opens Preferences on Accessibility, and plain Preferences on its default again", () => {
    const d = useDialogStore();
    d.shortcuts = true;
    createActions(e)("accessibility-settings");
    expect([d.preferences, d.prefsCategory, d.shortcuts, e.lastAction]).toEqual([true, "access", false, "extrude"]);
    d.preferences = false;
    createActions(e)("preferences");
    expect([d.preferences, d.prefsCategory]).toEqual([true, null]);
  });
});
