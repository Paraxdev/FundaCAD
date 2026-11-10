import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { allCommands, commandEnglish, commandLabel, groupText } from "../../src/ui/commands";
import { resetUserShortcuts, setUserShortcut, shortcutRows } from "../../src/input/shortcuts";
import { buildMenus, itemText, row } from "../app/menuRows";
import { createContextMenus, type ContextMenusDeps } from "../../src/ui/contextMenus";
import { useContextMenuStore } from "../../src/stores/contextMenu";
import { setLanguage } from "../../src/i18n";

beforeEach(() => setActivePinia(createPinia()));
afterEach(async () => {
  resetUserShortcuts();
  await setLanguage("system");
});

const labels = () => Object.fromEntries(allCommands().map((c) => [c.id, c.label]));

describe("command labels in the chosen language", () => {
  it("read English by default and German after a switch, for the same ids", async () => {
    const english = labels();
    const ids = allCommands().map((c) => c.id);
    await setLanguage("de");
    const german = labels();
    expect(Object.keys(german)).toEqual(ids);
    expect(german["saveas"]).toBe("Speichern unter…");
    expect(german["next-edge"]).toBe("Nächste Kante");
    expect(german["top"]).toBe("Draufsicht");
    expect(english["saveas"]).toBe("Save As…");
    const global = ["new", "save", "saveas", "fit", "go-tools", "next-face", "manual", "finish", "top", "iso"];
    for (const id of global) expect(german[id]).not.toBe(english[id]);
  });

  it("keep English as the alias and every group an id", async () => {
    await setLanguage("de");
    expect(commandEnglish("saveas")).toBe("Save As…");
    expect(commandEnglish("top")).toBe("Top View");
    expect(commandEnglish("extrude")).toBe("Extrude");
    expect(commandEnglish("line")).toBe("Line");
    expect(commandEnglish("plugin.thing")).toBeUndefined();
    expect(commandEnglish("no-such-command")).toBeUndefined();
    const groups = new Set(allCommands().map((c) => c.group));
    for (const g of ["File", "Edit", "View", "Go", "Help"]) expect(groups.has(g)).toBe(true);
    expect([...groups].some((g) => /[äöü]/.test(g))).toBe(false);
  });

  it("show the five built in groups in German and leave any other group alone", async () => {
    expect(["File", "Edit", "View", "Go", "Help"].map(groupText)).toEqual(["File", "Edit", "View", "Go", "Help"]);
    await setLanguage("de");
    expect(["File", "Edit", "View", "Go", "Help"].map(groupText)).toEqual([
      "Datei",
      "Bearbeiten",
      "Ansicht",
      "Gehe zu",
      "Hilfe",
    ]);
    expect(
      ["CREATE", "MODIFY", "CONSTRUCT", "INSPECT", "INSERT", "PATTERN", "CONSTRAINTS", "SKETCH"].map(groupText),
    ).toEqual(["Erstellen", "Ändern", "Konstruieren", "Prüfen", "Einfügen", "Muster", "Abhängigkeiten", "Skizze"]);
    expect(groupText("Plugin Group")).toBe("Plugin Group");
    expect(groupText("")).toBe("");
  });

  it("label a ribbon tool in German and fall back to the id for a plugin tool", async () => {
    await setLanguage("de");
    expect(commandLabel("extrude")).toBe("Extrusion");
    expect(commandLabel("plugin.thing")).toBe("plugin.thing");
    expect(allCommands().find((c) => c.id === "extrude")?.label).toBe("Extrusion");
  });

  it("read live through commandLabel, and fall back to the id for an unknown command", async () => {
    await setLanguage("de");
    expect(commandLabel("next-face")).toBe("Nächste Fläche");
    expect(commandLabel("not-a-command")).toBe("not-a-command");
  });
});

describe("keys and ids survive a language switch", () => {
  it("a chosen key still shows on the German palette entry and the Edit row, found by its English name", async () => {
    expect(
      setUserShortcut(shortcutRows().find((s) => s.action === "next-face")!.id, { key: "F", ctrl: true, shift: true }),
    ).toBeNull();
    await setLanguage("de");
    expect(allCommands().find((c) => c.id === "next-face")).toMatchObject({
      key: "Ctrl+Shift+F",
      label: "Nächste Fläche",
    });
    const edit = buildMenus();
    const face = row("Edit", "Next Face", edit);
    expect(itemText(face)).toBe("Nächste Fläche");
    expect(face.shortcut).toBe("Ctrl+Shift+F");
    expect(row("Edit", "Next Edge", edit).shortcut).toBeUndefined();
    await setLanguage("system");
    expect(itemText(face)).toBe("Next Face");
  });

  it("the last action stays an id, only the Repeat row's command name changes", async () => {
    const handleAction = vi.fn();
    const deps = { store: {}, sketch: { active: false }, viewport: {}, handleAction, getLastAction: () => "next-face" };
    const first = () => {
      createContextMenus(deps as unknown as ContextMenusDeps).openEmptyMenu(10, 10);
      return useContextMenuStore().items[0]!;
    };
    expect(first().label).toContain("Next Face");
    await setLanguage("de");
    const repeat = first();
    expect(repeat.label).toContain("Nächste Fläche");
    repeat.onClick!();
    expect(handleAction.mock.calls).toEqual([["next-face"]]);
  });
});
