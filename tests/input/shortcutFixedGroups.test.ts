// The fixed groups of the shortcuts window (mouse, 3D view focused, Always, conflicts) follow the language.

import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, tEnglish } from "../../src/i18n";
import de from "../../src/i18n/locales/de.json";
import en from "../../src/i18n/locales/en.json";
import {
  SHORTCUTS,
  checkShortcut,
  reservedLabel,
  setShortcutOverrides,
  shortcutHudGroups,
} from "../../src/input/shortcuts";
import {
  DEFAULT_BINDINGS,
  bindingEntries,
  bindingRows,
  setPointerBindings,
  type PointerBinding,
} from "../../src/viewport/navigator/bindings";

afterEach(async () => {
  setShortcutOverrides([]);
  setPointerBindings(null);
  await setLanguage("system");
});

const group = (id: string, tr?: typeof tEnglish) => shortcutHudGroups(new Set(), tr).find((g) => g.id === id);
const fill = (line: string, args: Record<string, string>) =>
  line.replace(/\{(\w+)\}/g, (_, k: string) => args[k] ?? `{${k}}`);

const SLANTED: PointerBinding[] = [
  { button: "middle", shift: true, drag: "pan" },
  { button: "right", alt: true, shift: true, drag: "orbit" },
  { button: "right", click: "menu" },
  { button: "middle", drag: "gesture", click: "menu" },
];

describe("bindingEntries and bindingRows", () => {
  it("bindingRows stays English for 0, 1, slanted and the default table", () => {
    expect(bindingRows([])).toEqual([]);
    expect(bindingRows([{ button: "middle", drag: "orbit" }])).toEqual([{ key: "Middle drag", label: "Orbit" }]);
    expect(bindingRows(SLANTED)).toEqual([
      { key: "Shift+middle drag", label: "Pan" },
      { key: "Shift+Alt+right drag", label: "Orbit" },
      { key: "Middle drag", label: "The radial menu" },
      { key: "Right click", label: "The context menu" },
      { key: "Middle click", label: "The context menu" },
    ]);
    expect(bindingRows(DEFAULT_BINDINGS)).toEqual([
      { key: "Shift+right drag", label: "Pan" },
      { key: "Right drag", label: "Orbit" },
      { key: "Middle drag", label: "Pan" },
      { key: "Right click", label: "The context menu" },
    ]);
  });

  it("entries hold the button, held modifiers, kind and what, one click per button", () => {
    expect(bindingEntries(SLANTED)).toEqual([
      { button: "middle", mods: ["Shift"], kind: "drag", what: "pan" },
      { button: "right", mods: ["Shift", "Alt"], kind: "drag", what: "orbit" },
      { button: "middle", mods: [], kind: "drag", what: "gesture" },
      { button: "right", mods: [], kind: "click", what: "menu" },
      { button: "middle", mods: [], kind: "click", what: "menu" },
    ]);
  });
});

describe("the fixed groups in German", () => {
  it("reads the mouse rows, gestures and headings from the language file", async () => {
    setPointerBindings(SLANTED, () => {});
    await setLanguage("de");
    const mouse = group("mouse")!;
    expect(mouse.name).toBe(de["shortcuts.group.mouse"]);
    expect(mouse.rows).toEqual([
      { key: "Shift+Mitte ziehen", label: de["shortcuts.mouse.pan"], changed: true },
      { key: "Shift+Alt+rechts ziehen", label: de["shortcuts.mouse.orbit"], changed: true },
      { key: "Mitte ziehen", label: de["shortcuts.mouse.radial"], changed: true },
      { key: "Rechts klicken", label: de["shortcuts.mouse.context"] },
      { key: "Mitte klicken", label: de["shortcuts.mouse.context"], changed: true },
      { key: de["shortcuts.mouse.wheel"], label: de["shortcuts.mouse.zoom"] },
      { key: `Ctrl+${de["shortcuts.mouse.wheel"]}`, label: de["shortcuts.mouse.panWheel"] },
      { key: "Links ziehen", label: de["shortcuts.mouse.boxSelect"] },
      { key: "Links klicken", label: de["shortcuts.mouse.pick"] },
    ]);
    expect(group("focus")!.name).toBe(de["shortcuts.group.focus"]);
    expect(group("focus")!.rows.map((r) => r.label)).toEqual(
      ["step", "stepKind", "select", "toggle", "drop"].map((k) => de[`shortcuts.focus.${k}` as keyof typeof de]),
    );
    const always = group("always")!;
    expect(always.name).toBe(de["shortcuts.group.always"]);
    expect(always.rows[0]).toEqual({ key: "Ctrl+K", label: de["palette.title"] });
    expect(always.rows.map((r) => r.key)).toEqual([
      "Ctrl+K",
      "Ctrl+Z / Ctrl+Y",
      "Ctrl+S / Ctrl+Shift+S",
      "Ctrl+N / Ctrl+O / Ctrl+E",
      "Ctrl+Plus / Ctrl+Minus / Ctrl+0",
      "Del",
      "Esc",
      de["shortcuts.mouse.drag"],
      `Shift+${de["shortcuts.mouse.drag"]}`,
      "Tab",
    ]);
  });

  it("the English build under de equals the English language, and no label is left raw", async () => {
    await setLanguage("en");
    const english = shortcutHudGroups();
    await setLanguage("de");
    expect(shortcutHudGroups(new Set(), tEnglish)).toEqual(english);
    const labels = shortcutHudGroups().flatMap((g) => g.rows.map((r) => r.label));
    expect(labels.filter((l) => /^[a-z]+(\.[a-zA-Z0-9]+)+$/.test(l) || l.includes("{"))).toEqual([]);
  });

  it("the English fixed rows keep their wording", () => {
    expect(
      group("mouse")!
        .rows.slice(-4)
        .map((r) => r.key),
    ).toEqual(["Wheel", "Ctrl+Wheel", "Left drag", "Left click"]);
    expect(
      group("always")!
        .rows.slice(-3)
        .map((r) => r.key),
    ).toEqual(["Drag", "Shift+Drag", "Tab"]);
    expect(group("always")!.rows[1]).toEqual({ key: "Ctrl+Z / Ctrl+Y", label: "Undo / Redo" });
  });
});

describe("the conflict line", () => {
  const keyOf = (action: string) => SHORTCUTS.find((s) => s.action === action && s.context === "model")!.key;

  it("is absent with none, one line with one, two lines with two, in German", async () => {
    await setLanguage("de");
    expect(group("conflicts")).toBeUndefined();
    setShortcutOverrides([{ action: "fillet", key: keyOf("extrude") }]);
    const one = group("conflicts")!;
    expect(one.name).toBe(de["shortcuts.group.conflicts"]);
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]!.label).toBe(
      fill(de["shortcuts.conflict"], { first: de["tool.fillet"], second: de["tool.extrude"] }),
    );
    expect(one.rows[0]!.label).not.toBe(
      fill(en["shortcuts.conflict"], { first: de["tool.fillet"], second: de["tool.extrude"] }),
    );
    setShortcutOverrides([
      { action: "fillet", key: keyOf("extrude") },
      { action: "move", key: keyOf("measure") },
    ]);
    const two = group("conflicts")!.rows.map((r) => r.label);
    expect(two).toHaveLength(2);
    expect(two[0]).toContain(de["tool.fillet"]);
    expect(two[1]).toContain(de["tool.move"]);
  });
});

describe("reservedLabel", () => {
  const values = [
    "Undo",
    "Redo",
    "Save",
    "Save As",
    "New",
    "Open",
    "Export",
    "Find",
    "Command palette",
    "Preferences",
    "Items",
    "History",
    "Console",
    "Interface size",
    "Cancel",
    "Box select filter",
    "Delete",
    "This sheet",
  ];

  it("labels every reserved value in German", async () => {
    await setLanguage("de");
    expect(values.map((v) => reservedLabel(v))).toEqual([
      de["command.undo"],
      de["command.redo"],
      de["command.save"],
      de["shortcuts.reserved.saveAs"],
      de["command.new"],
      de["shortcuts.reserved.open"],
      de["shortcuts.reserved.export"],
      de["shortcuts.reserved.find"],
      de["palette.title"],
      de["shortcuts.reserved.preferences"],
      de["shortcuts.reserved.items"],
      de["shortcuts.reserved.history"],
      de["shortcuts.reserved.console"],
      de["shortcuts.reserved.interfaceSize"],
      de["shortcuts.reserved.cancel"],
      de["shortcuts.reserved.boxFilter"],
      de["menu.edit.delete"],
      de["shortcuts.reserved.thisSheet"],
    ]);
  });

  it("every value the checker reports is in the list, and a made up value is returned as given", async () => {
    const keys = [
      ...["z", "y", "s", "n", "o", "e", "f", "k", ",", "`", "=", "-", "0"].map((key) => ({ key, ctrl: true })),
      { key: "s", ctrl: true, shift: true },
      { key: "1", ctrl: true, shift: true },
      { key: "Escape" },
      { key: "Tab" },
      { key: "Delete" },
      { key: "?" },
    ];
    for (const k of keys) {
      const p = checkShortcut({ action: "fillet", ...k });
      expect(p && "reserved" in p ? p.reserved : null).not.toBeNull();
      expect(values).toContain((p as { reserved: string }).reserved);
    }
    await setLanguage("de");
    expect(reservedLabel("Made Up Trigger 7")).toBe("Made Up Trigger 7");
  });
});
