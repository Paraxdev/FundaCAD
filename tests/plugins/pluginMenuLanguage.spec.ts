import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setLanguage } from "../../src/i18n";
import { contributedMenus } from "../../src/plugins/contrib";
import { activate as printing } from "../../plugins/FundaCAD.Printing/main";
import { activate as spaceMouse } from "../../plugins/FundaCAD.SpaceMouse/main";
import { activate as extraParameters } from "../../plugins/FundaCAD.ExtraParameters/main";
import { activate as onshape } from "../../plugins/FundaCAD.Onshape/main";
import type { Engine } from "../../src/app/engine";
import { itemText, rowName } from "../app/menuRows";

const rows = (menu: string, read: typeof itemText) =>
  contributedMenus()
    .filter((c) => c.menu === menu)
    .flatMap((c) => c.items.filter((i) => !i.separator).map(read));

const FILE = [
  "Export for Print (3MF)…",
  "Open in OrcaSlicer…",
  "Send to Printer…",
  "Camera…",
  "Import from Onshape link…",
];
const EDIT = ["Parameter Setup…"];
const VIEW = ["SpaceMouse: Object Mode", "SpaceMouse: Camera Mode", "3D Mouse Settings…"];

let stops: (() => void)[] = [];
beforeEach(async () => {
  setActivePinia(createPinia());
  const e = { store: {}, geometry: {} } as unknown as Engine;
  stops = [await printing(e), await onshape(e), await extraParameters(e), await spaceMouse(e)];
});
afterEach(async () => {
  stops.forEach((s) => s());
  await setLanguage("system");
});

describe("first party plugin menu rows", () => {
  it("read English with the system language", () => {
    expect(rows("File", itemText)).toEqual(FILE);
    expect(rows("Edit", itemText)).toEqual(EDIT);
    expect(rows("View", itemText)).toEqual(VIEW);
  });

  it("read German over the same English names", async () => {
    await setLanguage("de");
    expect(rows("File", itemText)).toEqual([
      "Für den Druck exportieren (3MF)…",
      "In OrcaSlicer öffnen…",
      "An Drucker senden…",
      "Kamera…",
      "Aus Onshape-Link importieren…",
    ]);
    expect(rows("Edit", itemText)).toEqual(["Parameter einrichten…"]);
    expect(rows("View", itemText)).toEqual([
      "SpaceMouse: Objektmodus",
      "SpaceMouse: Kameramodus",
      "3D-Maus-Einstellungen…",
    ]);
    expect([rows("File", rowName), rows("Edit", rowName), rows("View", rowName)]).toEqual([FILE, EDIT, VIEW]);
  });

  it("follow a second switch from the same contribution, Japanese then back", async () => {
    await setLanguage("ja");
    expect(rows("Edit", itemText)).toEqual(["パラメーター設定…"]);
    expect(rows("View", itemText)[2]).toBe("3D マウス設定…");
    await setLanguage("system");
    expect(rows("View", itemText)).toEqual(VIEW);
  });
});
