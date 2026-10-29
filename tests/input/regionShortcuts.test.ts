// F6 and Shift+F6 step between the regions of the shell, so Fit keeps Home alone.

import { describe, expect, it } from "vitest";
import { SHORTCUTS, keyHint, resolveShortcut } from "../../src/input/shortcuts";
import { allCommands } from "../../src/ui/commands";
import { NON_REPEATABLE } from "../../src/app/actionTables";

describe("region keys", () => {
  it("F6 and Shift+F6 step to the next and previous region in both contexts", () => {
    for (const ctx of ["model", "sketch"] as const) {
      expect(resolveShortcut("F6", false, ctx)).toBe("region-next");
      expect(resolveShortcut("F6", true, ctx)).toBe("region-prev");
    }
    expect(keyHint("region-next")).toBe("F6");
    expect(keyHint("region-prev")).toBe("Shift+F6");
  });

  it("never overwrite the Repeat command", () => {
    expect(NON_REPEATABLE.has("region-next")).toBe(true);
    expect(NON_REPEATABLE.has("region-prev")).toBe(true);
  });
});

describe("Fit view", () => {
  it("is bound to Home only", () => {
    expect(SHORTCUTS.filter((s) => s.action === "fit").map((s) => s.key)).toEqual(["home"]);
    expect(allCommands().find((c) => c.id === "fit")?.key).toBe("Home");
  });
});
