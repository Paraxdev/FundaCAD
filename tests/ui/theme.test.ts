import { describe, it, expect } from "vitest";
import { DEFAULT_THEME_ID, THEMES, asThemeId, themeMode } from "../../src/ui/theme";

describe("asThemeId", () => {
  it("accepts every theme that ships", () => {
    for (const t of THEMES) expect(asThemeId(t.id)).toBe(t.id);
  });

  it("rejects anything unknown", () => {
    // An unknown id would stamp a data-theme attribute no rule matches, leaving
    // the previous palette on screen, which looks like the setting silently not
    // working rather than like a value being refused. Every boundary that can
    // set the theme (stored setting, <select> value) goes through this gate.
    expect(asThemeId("dracula")).toBeNull();
    expect(asThemeId("")).toBeNull();
    expect(asThemeId(null)).toBeNull();
    expect(asThemeId(7)).toBeNull();
    expect(asThemeId({ id: "forge" })).toBeNull();
  });
});

describe("the theme roster", () => {
  it("has the default among them", () => {
    expect(THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true);
  });

  it("has unique ids", () => {
    // Two themes sharing an id would make the picker unselectable in one
    // direction: setTheme would accept it, the <select> would show the first.
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  it("offers at least one light palette", () => {
    // The light theme is the one that genuinely exercises the token set, a
    // shadow tuned for near-black surfaces vanishes on white, so if it renders
    // correctly the others almost certainly do.
    expect(THEMES.some((t) => t.mode === "light")).toBe(true);
  });

  it("labels every theme for the picker", () => {
    for (const t of THEMES) expect(t.label.trim().length).toBeGreaterThan(0);
  });
});

describe("themeMode", () => {
  it("reports the mode of a known theme", () => {
    expect(themeMode("paper")).toBe("light");
    expect(themeMode("forge")).toBe("dark");
  });

  it("assumes dark for an unknown id", () => {
    // Only ever reached through a bad caller; dark is the safer guess because
    // three of four palettes are dark and the app's chrome is built for it.
    expect(themeMode("nope")).toBe("dark");
  });
});
