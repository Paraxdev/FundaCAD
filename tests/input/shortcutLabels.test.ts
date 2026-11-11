// Shortcut names follow the language, as read from the table's say functions and not from a copied row.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguage, tEnglish } from "../../src/i18n";
import de from "../../src/i18n/locales/de.json";
import en from "../../src/i18n/locales/en.json";
import { commandLabel } from "../../src/ui/commands";
import { toolLabel } from "../../src/ui/ribbonDefs";
import {
  SHORTCUTS,
  resetUserShortcuts,
  setUserShortcut,
  shortcutGroupsOf,
  shortcutHudGroups,
  shortcutLabel,
  shortcutRows,
  type Shortcut,
} from "../../src/input/shortcuts";

afterEach(async () => {
  resetUserShortcuts();
  await setLanguage("system");
});

const LANGUAGES = ["en", "de", "fr", "es", "ja", "zh-CN"] as const;
const raw = (label: string) => /^[a-z]+(\.[a-zA-Z0-9]+)+$/.test(label) || label.includes("{");
const rawLabels = (labels: string[]) => labels.filter(raw);
const tableLabels = () => shortcutHudGroups().flatMap((g) => g.rows.map((r) => r.label));
const row = (action: string, context: Shortcut["context"]) =>
  SHORTCUTS.find((s) => s.action === action && s.context === context)!;
const hudRow = (id: string) =>
  shortcutHudGroups()
    .flatMap((g) => g.rows)
    .find((r) => r.id === id);

describe("the raw key detector", () => {
  it("flags a key, a key with an argument left in, and nothing else", () => {
    expect(rawLabels(["tool.fillet", "Sketch: {tool}", "shortcuts.action.turnLeft", "Fillet", "Sketch: Line"])).toEqual(
      ["tool.fillet", "Sketch: {tool}", "shortcuts.action.turnLeft"],
    );
  });
});

describe("every shortcut name in every language", () => {
  it.each(LANGUAGES)("shows no raw key or open argument under %s", async (code) => {
    await setLanguage(code);
    const labels = [...tableLabels(), ...shortcutRows().map((r) => shortcutLabel(r))];
    expect(labels.length).toBeGreaterThan(80);
    expect(rawLabels(labels)).toEqual([]);
    expect(labels.every((l) => l.trim().length > 0)).toBe(true);
  });
});

describe("headings", () => {
  it("read the German lines, Sketch the same line the rail uses", async () => {
    await setLanguage("de");
    const named = Object.fromEntries(shortcutHudGroups().map((g) => [g.id, g.name]));
    expect(named).toMatchObject({
      model: de["shortcuts.group.model"],
      sketch: de["tool.sketch"],
      global: de["shortcuts.group.global"],
    });
    expect(named.sketch).toBe(toolLabel("sketch"));
  });

  it("stay English in English, ids unchanged", () => {
    expect(
      shortcutHudGroups()
        .map((g) => [g.id, g.name])
        .slice(0, 3),
    ).toEqual([
      ["model", "Model"],
      ["sketch", "Sketch"],
      ["global", "Global"],
    ]);
  });
});

describe("one name per action", () => {
  // These keep a name of their own, the rail's line is an abbreviation or a different thing.
  const OWN_LINE = new Set(["chamfer", "coincident", "perpendicular", "fillet-sketch"]);
  const startsSketch = (s: Shortcut) => s.context === "model" && row(s.action, "sketch") !== undefined;

  it("a tool row reads the rail's line, under German", async () => {
    await setLanguage("de");
    const tools = SHORTCUTS.filter(
      (s) =>
        toolLabel(s.action) !== undefined &&
        !OWN_LINE.has(s.action) &&
        !startsSketch(s) &&
        !(s.context === "sketch" && s.action.match(/^(extrude|presspull)$/)),
    );
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.map((s) => [s.action, shortcutLabel(s)])).toEqual(tools.map((s) => [s.action, toolLabel(s.action)]));
  });

  it("a command row reads the palette's line, under German", async () => {
    await setLanguage("de");
    const ids = ["fit", "reset-camera", "show-all-bodies", "next-face", "previous-face", "next-edge", "previous-edge"];
    ids.push("browse-geometry", "viewmode-cycle");
    expect(ids.map((id) => shortcutLabel(SHORTCUTS.find((s) => s.action === id)!))).toEqual(ids.map(commandLabel));
  });
});

describe("copies do not freeze a language", () => {
  it("a row list built in English shows German after a switch", async () => {
    const before = shortcutRows();
    expect(before.find((r) => r.id === "fillet|model|F")?.label).toBe("Fillet");
    await setLanguage("de");
    expect(shortcutLabel(before.find((r) => r.id === "fillet|model|F")!)).toBe(de["tool.fillet"]);
    expect(hudRow("fillet|model|F")?.label).toBe(de["tool.fillet"]);
  });

  it("a row a person moved reads German too", async () => {
    expect(setUserShortcut("fillet|model|F", { key: "g", shift: true })).toBeNull();
    await setLanguage("de");
    expect(hudRow("fillet|model|F")).toMatchObject({ key: "Shift+G", label: de["tool.fillet"], changed: true });
  });
});

describe("names with an argument", () => {
  it("Sketch: Line and Finish & Extrude hold the German tool line", async () => {
    await setLanguage("de");
    expect(shortcutLabel(row("line", "model"))).toBe(
      de["shortcuts.action.sketchWith"].replace("{tool}", de["tool.line"]),
    );
    expect(shortcutLabel(row("extrude", "sketch"))).toBe(
      de["shortcuts.action.finishWith"].replace("{tool}", de["tool.extrude"]),
    );
  });

  it("the eight turn rows hold 15 or 5 and the direction", async () => {
    await setLanguage("de");
    const deg = (k: "turnLeft" | "turnRight" | "tiltUp" | "tiltDown", n: number) =>
      de[`shortcuts.action.${k}`].replace("{deg, number}", String(n));
    const turns = SHORTCUTS.filter((s) => s.action.startsWith("view-step-"));
    expect(turns.map((s) => [s.action, shortcutLabel(s)])).toEqual([
      ["view-step-left", deg("turnLeft", 15)],
      ["view-step-right", deg("turnRight", 15)],
      ["view-step-up", deg("tiltUp", 15)],
      ["view-step-down", deg("tiltDown", 15)],
      ["view-step-left-fine", deg("turnLeft", 5)],
      ["view-step-right-fine", deg("turnRight", 5)],
      ["view-step-up-fine", deg("tiltUp", 5)],
      ["view-step-down-fine", deg("tiltDown", 5)],
    ]);
  });

  it("a page of no turn rows, one and two shows only what it holds", () => {
    const names = (actions: string[]) => shortcutGroupsOf(new Set(actions)).flatMap((g) => g.rows.map((r) => r.label));
    expect(names(["no-such-action"])).toEqual([]);
    expect(names(["view-step-left"])).toEqual(["Turn the view left 15°"]);
    expect(names(["view-step-left", "view-step-up-fine"])).toEqual(["Turn the view left 15°", "Tilt the view up 5°"]);
  });
});

describe("the English alias", () => {
  it("a build with tEnglish under German equals the English build", async () => {
    const english = shortcutHudGroups();
    await setLanguage("de");
    expect(shortcutHudGroups(new Set(), tEnglish)).toEqual(english);
    expect(shortcutHudGroups().map((g) => g.name)).not.toEqual(english.map((g) => g.name));
  });

  it("keeps the English words of the table", () => {
    expect(tEnglish("shortcuts.action.chamfer")).toBe(en["shortcuts.action.chamfer"]);
    expect(shortcutLabel(row("chamfer", "model"), tEnglish)).toBe("Chamfer (bevel)");
  });
});

describe("the stored keymap", () => {
  const store = new Map<string, string>();
  const stored = () => store.get("fundacad.keymap") ?? null;
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is the same under German as under English, and a second keymap leaves nothing of the first", async () => {
    setUserShortcut("fillet|model|F", { key: "g" });
    const english = stored();
    resetUserShortcuts();
    await setLanguage("de");
    setUserShortcut("fillet|model|F", { key: "g" });
    expect(stored()).toBe(english);
    expect(JSON.parse(stored()!)).toEqual([{ id: "fillet|model|F", key: "g" }]);

    resetUserShortcuts();
    setUserShortcut("move|model|M", { key: "m", shift: true });
    expect(JSON.parse(stored() ?? "[]")).toEqual([{ id: "move|model|M", key: "m", shift: true }]);
  });
});
