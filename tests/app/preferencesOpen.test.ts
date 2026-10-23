import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createActions } from "../../src/app/actions";
import { NON_REPEATABLE } from "../../src/app/actionTables";
import { allCommands } from "../../src/ui/commands";
import { useDialogStore } from "../../src/stores/dialogs";
import type { Engine } from "../../src/app/engine";

const e = { sketch: { active: false }, lastAction: "extrude" } as unknown as Engine;

beforeEach(() => setActivePinia(createPinia()));

describe("the palette's Preferences and Keyboard shortcuts", () => {
  it("are listed once each, and neither repeats as the last command", () => {
    const cmds = allCommands().filter((c) => c.id === "preferences" || c.id === "shortcut-help");
    expect(cmds.map((c) => [c.id, c.group, c.key])).toEqual([
      ["preferences", "Edit", "Ctrl+,"],
      ["shortcut-help", "Help", "?"],
    ]);
    expect(["preferences", "shortcut-help"].filter((id) => !NON_REPEATABLE.has(id))).toEqual([]);
  });

  it("the action opens Preferences and closes the shortcuts dialog under it", () => {
    const d = useDialogStore();
    d.shortcuts = true;
    createActions(e)("preferences");
    expect([d.preferences, d.shortcuts, e.lastAction]).toEqual([true, false, "extrude"]);
    createActions(e)("preferences");
    expect([d.preferences, d.shortcuts]).toEqual([true, false]);
  });
});
