// The arrow keys step the view, and the ? sheet lists them.

import { describe, expect, it } from "vitest";
import { resolveShortcut, shortcutHudGroups } from "../../src/input/shortcuts";
import { asOrbitPivot, getNavPrefs, setNavPrefs } from "../../src/ui/interactionPrefs";

describe("arrow keys", () => {
  it("resolve to view steps in both contexts, Shift for the fine step", () => {
    for (const ctx of ["model", "sketch"] as const) {
      expect(resolveShortcut("arrowleft", false, ctx)).toBe("view-step-left");
      expect(resolveShortcut("arrowright", false, ctx)).toBe("view-step-right");
      expect(resolveShortcut("arrowup", false, ctx)).toBe("view-step-up");
      expect(resolveShortcut("arrowdown", false, ctx)).toBe("view-step-down");
      expect(resolveShortcut("arrowleft", true, ctx)).toBe("view-step-left-fine");
    }
  });

  it("are listed on the ? sheet by their plain names", () => {
    const rows = shortcutHudGroups().flatMap((g) => g.rows);
    const keys = rows.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["Left", "Right", "Up", "Down", "Shift+Left"]));
    expect(rows.find((r) => r.key === "Left")?.label).toContain("15");
    expect(rows.find((r) => r.key === "Shift+Left")?.label).toContain("5");
  });
});

describe("orbit pivot preference", () => {
  it("defaults to the model under the cursor and takes the three names only", () => {
    expect(getNavPrefs().orbitPivot).toBe("auto");
    expect(asOrbitPivot("origin")).toBe("origin");
    expect(asOrbitPivot("selection")).toBe("selection");
    expect(asOrbitPivot("centre")).toBeNull();
  });

  it("is set through setNavPrefs", () => {
    setNavPrefs({ orbitPivot: "origin" });
    expect(getNavPrefs().orbitPivot).toBe("origin");
    setNavPrefs({ orbitPivot: "auto" });
  });
});
