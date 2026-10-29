import { afterEach, describe, expect, it } from "vitest";

import {
  addCustomTheme,
  asThemeId,
  BUILTIN_THEME,
  customThemes,
  DEFAULT_THEME_ID,
  getTheme,
  NOIR_PALETTE,
  removeCustomTheme,
  setTheme,
  themeMode,
  themes,
  type ShippedTheme,
} from "../../src/ui/theme";
import { oklch } from "../../src/viewport/pickColors";
import { AXIS_COLOR } from "../../src/viewport/originTriad";
import tokensScss from "../../src/styles/_tokens.scss?raw";

// The module is a singleton with mutable state (the uploaded-theme library and
// the active id), so every test that adds a palette clears it again, and the
// active theme is put back to the built-in one. Without this a leftover custom
// theme from one test would change the roster another test asserts on.

afterEach(() => {
  setTheme(DEFAULT_THEME_ID);

  for (const t of customThemes()) {
    removeCustomTheme(t.id);
  }
});

describe("asThemeId", () => {
  it("accepts the built-in theme and System, the default", () => {
    expect(asThemeId(BUILTIN_THEME.id)).toBe(BUILTIN_THEME.id);
    expect(DEFAULT_THEME_ID).toBe("system");
    expect(asThemeId(DEFAULT_THEME_ID)).toBe("system");
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
    expect(asThemeId("not-a-real-theme")).toBeNull();
    expect(asThemeId("")).toBeNull();
    expect(asThemeId(null)).toBeNull();
    expect(asThemeId(7)).toBeNull();
    expect(asThemeId({ id: "forge" })).toBeNull();
  });
});

describe("the theme roster", () => {
  it("leads with System, then the built-in theme, and labels every entry", () => {
    const list = themes();

    expect(list[0]?.id).toBe("system");
    expect(list[1]).toStrictEqual(BUILTIN_THEME);

    for (const t of list) {
      expect(t.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("has unique ids across built-in and uploaded", () => {
    addCustomTheme({
      label: "one",
      "--accent": "#f0982d",
    });

    addCustomTheme({
      label: "two",
      "--accent": "#112233",
    });

    const ids = themes().map((t) => t.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ships Dracula (dark) and Solarized Light (light) alongside the built-in theme", () => {
    const list = themes();

    expect(list.find((t) => t.id === "dracula")).toMatchObject({
      label: "Dracula",
      mode: "dark",
      custom: false,
    });

    expect(list.find((t) => t.id === "solarized-light")).toMatchObject({
      label: "Solarized Light",
      mode: "light",
      custom: false,
    });
  });

  it("ships a colour-blind safe theme whose status colours are all distinct", () => {
    const theme = themes().find((t) => t.id === "colorblind-safe");

    expect(theme).toMatchObject({
      label: "Colour-Blind Safe",
      mode: "dark",
      custom: false,
    });

    const { palette } = theme as ShippedTheme;

    // ok/warn/error must never collapse to one colour: that is the whole point.
    const status = new Set([palette["--ok"], palette["--warn"], palette["--error"]]);

    expect(status.size).toBe(3);
  });

  it("gives the colour-blind safe theme an accent that reads apart from Noir's own", () => {
    const hex = (c: string) => parseInt(c.slice(1), 16);
    const lab = (c: string) => {
      const [L, C, h] = oklch(hex(c));
      return [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
    };
    const noir = lab(/--accent:\s*(#[0-9a-f]{6})/.exec(tokensScss)?.[1] ?? "");
    const safe = lab((themes().find((t) => t.id === "colorblind-safe") as ShippedTheme).palette["--accent"] ?? "");

    expect(Math.hypot(...noir.map((v, i) => v - (safe[i] ?? NaN)))).toBeGreaterThan(0.12);
  });

  it("steps the colour-blind safe axes apart in lightness, which every kind of colour blindness still sees", () => {
    const palette = (themes().find((t) => t.id === "colorblind-safe") as ShippedTheme).palette;
    const L = ["--axis-x", "--axis-y", "--axis-z"].map((k) => oklch(parseInt((palette[k] ?? "").slice(1), 16))[0]);

    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [0, 2],
    ] as const) {
      expect(Math.abs(L[a]! - L[b]!)).toBeGreaterThan(0.08);
    }
  });

  it("keeps Noir's axis tokens in step with the viewport's fallbacks", () => {
    for (const [axis, hex] of Object.entries(AXIS_COLOR)) {
      const token = new RegExp(`--axis-${axis}:\\s*#([0-9a-f]{6});`).exec(tokensScss)?.[1];

      expect(parseInt(token ?? "", 16)).toBe(hex);
    }
  });

  it("cannot remove a shipped theme", () => {
    setTheme("dracula");

    removeCustomTheme("dracula");

    expect(getTheme()).toBe("dracula");
    expect(asThemeId("dracula")).toBe("dracula");
  });

  it("ships three dark Noir tints, each with its own accent", () => {
    const list = themes();

    const blue = list.find((t) => t.id === "noir-blue");
    const red = list.find((t) => t.id === "noir-red");
    const orange = list.find((t) => t.id === "noir-orange");

    expect(blue).toMatchObject({
      label: "Noir Blue",
      mode: "dark",
      custom: false,
    });

    expect(red).toMatchObject({
      label: "Noir Red",
      mode: "dark",
      custom: false,
    });

    expect(orange).toMatchObject({
      label: "Noir Orange",
      mode: "dark",
      custom: false,
    });

    expect(blue).toBeDefined();
    expect(red).toBeDefined();
    expect(orange).toBeDefined();

    const accents = new Set([
      (blue as ShippedTheme).palette["--accent"],
      (red as ShippedTheme).palette["--accent"],
      (orange as ShippedTheme).palette["--accent"],
    ]);

    expect(accents.size).toBe(3);
  });
});

describe("themeMode", () => {
  it("reports dark for the built-in theme", () => {
    expect(themeMode(BUILTIN_THEME.id)).toBe("dark");
  });

  it("reports the mode an uploaded theme declared", () => {
    const res = addCustomTheme({
      label: "Bright",
      mode: "light",
      "--bg": "#ffffff",
    });

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

    const res = addCustomTheme({
      color: "red",
      "--nonsense": "#fff",
      "--bg": "not-a-colour",
    });

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

  it("keeps an uploaded control edge colour", () => {
    const res = addCustomTheme({ "--bg": "#141414", "--control-edge": "rgba(255, 255, 255, 0.6)" });

    expect(res.ok && res.theme.palette["--control-edge"]).toBe("rgba(255, 255, 255, 0.6)");
  });

  it("loads an older theme that still sets the retired glow, without the glow", () => {
    const res = addCustomTheme({
      label: "Old mint",
      mode: "light",
      "--bg": "#fdf6e3",
      "--accent": "#268bd2",
      "--accent-glow": "rgba(38, 139, 210, 0.35)",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.theme.palette).toStrictEqual({ "--bg": "#fdf6e3", "--accent": "#268bd2" });
    expect(themeMode(res.theme.id)).toBe("light");
  });

  it("ships no theme that lights a glow", () => {
    const glowing = themes().filter((t) => "palette" in t && "--accent-glow" in (t as ShippedTheme).palette);
    expect(glowing.map((t) => t.id)).toEqual([]);
  });

  it("rejects a value that tries to break out of a declaration", () => {
    // The value is set with setProperty (which cannot break out anyway), but the
    // grammar refuses it up front so a hostile file is a no-op, not a stored one.

    const res = addCustomTheme({
      "--bg": "#000; } body{ display:none } .x{ color:#000",
    });

    expect(res.ok).toBe(false);
  });

  it("reads a nested palette wrapper as well as a flat map", () => {
    const res = addCustomTheme({
      label: "Wrapped",
      palette: {
        "--panel": "#222",
      },
    });

    expect(res.ok && res.theme.palette).toStrictEqual({
      "--panel": "#222",
    });
  });

  it("drops a value shaped like rgb() that names no colour, so the contrast check never throws", () => {
    const res = addCustomTheme({ "--bg": "#111111", "--panel": "rgb(1, 2)" });

    expect(res.ok && res.theme.palette).toStrictEqual({ "--bg": "#111111" });
  });

  it("lists the pairs a low contrast upload fails, worst first, with the bar each misses", () => {
    const res = addCustomTheme({ label: "Murk", "--text-mute": "#4a4458", "--line-strong": "#3a3448" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const failing = res.failing.map((r) => r.what);
    expect(failing).toEqual(expect.arrayContaining(["--text-mute on --panel", "--line-strong on --raised"]));
    expect(res.failing.every((r) => r.ratio < r.min)).toBe(true);
    const share = res.failing.map((r) => r.ratio / r.min);
    expect(share).toEqual([...share].sort((a, b) => a - b));
    expect(res.failing.find((r) => r.what === "--text-mute on --panel")?.min).toBe(4.5);
  });

  it("lists no pair for an upload of any palette FundaCAD ships", () => {
    const shipped = themes().filter((t): t is ShippedTheme => "palette" in t && !t.custom);
    const flagged = shipped.flatMap((t) => {
      const res = addCustomTheme({ label: t.label, mode: t.mode, ...t.palette });
      return res.ok ? res.failing.map((r) => `${t.label}: ${r.what}`) : [`${t.label}: refused`];
    });

    expect(flagged).toEqual([]);
  });

  it("checks an upload against Noir's own value for every token it leaves out", () => {
    const root = tokensScss.slice(0, tokensScss.indexOf(":root.theme-light"));
    const drifted = Object.entries(NOIR_PALETTE).filter(([token, value]) => !root.includes(`${token}: ${value};`));

    expect(drifted).toEqual([]);
    expect(Object.keys(NOIR_PALETTE)).toEqual(
      expect.arrayContaining([
        "--panel",
        "--text-mute",
        "--accent",
        "--on-accent",
        "--field-bg",
        "--check-off",
        "--axis-z",
      ]),
    );
  });

  it("names a theme from its label, then name, then filename", () => {
    const a = addCustomTheme({
      label: "Studio",
      "--bg": "#111",
    });

    const b = addCustomTheme({
      name: "Loft",
      "--bg": "#111",
    });

    const c = addCustomTheme({ "--bg": "#111" }, "Warehouse.json");

    expect(a.ok && a.theme.label).toBe("Studio");
    expect(b.ok && b.theme.label).toBe("Loft");
    expect(c.ok && c.theme.label).toBe("Warehouse");
  });

  it("gives two themes with the same label distinct ids", () => {
    const a = addCustomTheme({
      label: "Twin",
      "--bg": "#111",
    });

    const b = addCustomTheme({
      label: "Twin",
      "--bg": "#222",
    });

    expect(a.ok && b.ok && a.theme.id !== b.theme.id).toBe(true);
  });
});

describe("removeCustomTheme", () => {
  it("cannot remove the built-in theme", () => {
    removeCustomTheme(BUILTIN_THEME.id);

    expect(themes()[1]).toStrictEqual(BUILTIN_THEME);
  });

  it("falls back to System when the active one is removed", () => {
    const res = addCustomTheme({
      label: "Temp",
      "--bg": "#123456",
    });

    expect(res.ok).toBe(true);

    if (!res.ok) return;

    setTheme(res.theme.id);

    expect(getTheme()).toBe(res.theme.id);

    removeCustomTheme(res.theme.id);

    expect(getTheme()).toBe(DEFAULT_THEME_ID);
  });
});
