import { afterEach, describe, expect, it } from "vitest";
import {
  addCustomTheme,
  asThemeId,
  BUILTIN_THEME,
  customThemes,
  DEFAULT_THEME_ID,
  getTheme,
  removeCustomTheme,
  setTheme,
  themeMode,
  themes,
} from "../../src/ui/theme";

// The module is a singleton with mutable state (the uploaded-theme library and
// the active id), so every test that adds a palette clears it again, and the
// active theme is put back to the built-in one. Without this a leftover custom
// theme from one test would change the roster another test asserts on.
afterEach(() => {
  setTheme(DEFAULT_THEME_ID);
  for (const t of customThemes()) removeCustomTheme(t.id);
});

describe("asThemeId", () => {
  it("accepts the built-in theme", () => {
    expect(asThemeId(BUILTIN_THEME.id)).toBe(BUILTIN_THEME.id);
    expect(DEFAULT_THEME_ID).toBe(BUILTIN_THEME.id);
  });

  it("accepts an uploaded theme once it exists, and not before", () => {
    // The roster is dynamic now: an id is valid only while the palette it names
    // is in the library. This is the whole reason asThemeId reads the live set
    // rather than a constant, a removed theme's id must stop being accepted.
    const res = addCustomTheme({ "--bg": "#010203" }, "Midnight.json");
    expect(res.ok).toBe(true);
    const id = res.ok ? res.theme.id : "";
    expect(asThemeId(id)).toBe(id);
    removeCustomTheme(id);
    expect(asThemeId(id)).toBeNull();
  });

  it("rejects anything unknown", () => {
    expect(asThemeId("dracula")).toBeNull();
    expect(asThemeId("")).toBeNull();
    expect(asThemeId(null)).toBeNull();
    expect(asThemeId(7)).toBeNull();
    expect(asThemeId({ id: "forge" })).toBeNull();
  });
});

describe("the theme roster", () => {
  it("leads with the built-in theme and labels every entry", () => {
    const list = themes();
    expect(list[0]).toStrictEqual(BUILTIN_THEME);
    for (const t of list) expect(t.label.trim().length).toBeGreaterThan(0);
  });

  it("has unique ids across built-in and uploaded", () => {
    addCustomTheme({ label: "one", "--accent": "#f0982d" });
    addCustomTheme({ label: "two", "--accent": "#112233" });
    const ids = themes().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("themeMode", () => {
  it("reports dark for the built-in theme", () => {
    expect(themeMode(BUILTIN_THEME.id)).toBe("dark");
  });

  it("reports the mode an uploaded theme declared", () => {
    const res = addCustomTheme({ label: "Bright", mode: "light", "--bg": "#ffffff" });
    expect(res.ok && themeMode(res.theme.id)).toBe("light");
  });

  it("assumes dark for an unknown id", () => {
    // Only ever reached through a bad caller; dark is the safer guess because the
    // built-in palette and the app's chrome are built for it.
    expect(themeMode("nope")).toBe("dark");
  });
});

describe("addCustomTheme", () => {
  it("refuses anything that is not an object", () => {
    for (const bad of [null, "x", 7, undefined]) {
      const res = addCustomTheme(bad as unknown);
      expect(res.ok).toBe(false);
    }
  });

  it("refuses an object with no usable colour tokens", () => {
    // Unknown keys are dropped, so an object of them is as empty as {}.
    const res = addCustomTheme({ color: "red", "--nonsense": "#fff", "--bg": "not-a-colour" });
    expect(res.ok).toBe(false);
  });

  it("keeps only whitelisted tokens with colour values", () => {
    const res = addCustomTheme({
      "--bg": "#141414",
      "--accent": "rgba(240, 152, 45, 0.5)",
      "--radius": "8px", // not whitelisted
      "--r-sm": "0", // shape token, not a palette token
      "--text": "javascript:alert(1)", // not a colour
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.theme.palette).toStrictEqual({
      "--bg": "#141414",
      "--accent": "rgba(240, 152, 45, 0.5)",
    });
  });

  it("rejects a value that tries to break out of a declaration", () => {
    // The value is set with setProperty (which cannot break out anyway), but the
    // grammar refuses it up front so a hostile file is a no-op, not a stored one.
    const res = addCustomTheme({ "--bg": "#000; } body{ display:none } .x{ color:#000" });
    expect(res.ok).toBe(false);
  });

  it("reads a nested palette wrapper as well as a flat map", () => {
    const res = addCustomTheme({ label: "Wrapped", palette: { "--panel": "#222" } });
    expect(res.ok && res.theme.palette).toStrictEqual({ "--panel": "#222" });
  });

  it("names a theme from its label, then name, then filename", () => {
    const a = addCustomTheme({ label: "Studio", "--bg": "#111" });
    const b = addCustomTheme({ name: "Loft", "--bg": "#111" });
    const c = addCustomTheme({ "--bg": "#111" }, "Warehouse.json");
    expect(a.ok && a.theme.label).toBe("Studio");
    expect(b.ok && b.theme.label).toBe("Loft");
    expect(c.ok && c.theme.label).toBe("Warehouse");
  });

  it("gives two themes with the same label distinct ids", () => {
    const a = addCustomTheme({ label: "Twin", "--bg": "#111" });
    const b = addCustomTheme({ label: "Twin", "--bg": "#222" });
    expect(a.ok && b.ok && a.theme.id !== b.theme.id).toBe(true);
  });
});

describe("removeCustomTheme", () => {
  it("cannot remove the built-in theme", () => {
    removeCustomTheme(BUILTIN_THEME.id);
    expect(themes()[0]).toStrictEqual(BUILTIN_THEME);
  });

  it("falls back to the built-in theme when the active one is removed", () => {
    const res = addCustomTheme({ label: "Temp", "--bg": "#123456" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    setTheme(res.theme.id);
    expect(getTheme()).toBe(res.theme.id);
    removeCustomTheme(res.theme.id);
    expect(getTheme()).toBe(DEFAULT_THEME_ID);
  });
});
