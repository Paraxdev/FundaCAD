import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createActions } from "../../src/app/actions";
import { NON_REPEATABLE } from "../../src/app/actionTables";
import { allCommands } from "../../src/ui/commands";
import { consoleOpen, setConsoleOpen, takeConsoleFocus } from "../../src/ui/logStore";
import type { Engine } from "../../src/app/engine";

const e = { sketch: { active: false }, lastAction: "extrude" } as unknown as Engine;

beforeEach(() => {
  setActivePinia(createPinia());
  setConsoleOpen(false);
  takeConsoleFocus();
});

describe("the palette's Show Console", () => {
  it("is listed once in View, does not repeat, and has no key", () => {
    const cmds = allCommands().filter((c) => c.id === "show-console");
    expect(cmds.map((c) => [c.label, c.group, c.key])).toEqual([["Show Console", "View", undefined]]);
    expect(NON_REPEATABLE.has("show-console")).toBe(true);
  });

  it("opens the console with focus on its heading, and keeps it open when run again", () => {
    createActions(e)("show-console");
    expect([consoleOpen(), takeConsoleFocus(), e.lastAction]).toEqual([true, true, "extrude"]);
    createActions(e)("show-console");
    expect([consoleOpen(), takeConsoleFocus()]).toEqual([true, true]);
  });
});
