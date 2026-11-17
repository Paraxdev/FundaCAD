import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activate as activateExtra } from "../../plugins/FundaCAD.ExtraParameters/main";
import { activate as activateOnshape } from "../../plugins/FundaCAD.Onshape/main";
import { activate as activatePrinting } from "../../plugins/FundaCAD.Printing/main";
import { activate as activateScrews } from "../../plugins/FundaCAD.Screws/main";
import { activate as activateMouse } from "../../plugins/FundaCAD.SpaceMouse/main";
import { pluginText, reloadLanguageFiles, setLanguage } from "../../src/i18n";
import { contributedBodyMenu, resetContributions } from "../../src/plugins/contrib";
import type { Engine } from "../../src/app/engine";
import { menuOf, names, texts } from "../app/menuRows";

const spec = { name: "M5 x 20" };
const screwEngine = {
  viewport: { domElement: document.createElement("canvas") },
  store: {
    buildState: { result: { bodies: [{ id: "body7", faceOwners: ["f9", "f9"] }] } },
    document: { features: [{ id: "f9", type: "import", generatedBy: { plugin: "FundaCAD.Screws", spec } }] },
  },
} as unknown as Engine;

const engine = { viewport: {}, store: {}, geometry: {} } as unknown as Engine;
let stops: (() => void)[] = [];

const coreRows = (menu: string) => menuOf(menu).items.length;
const base = { File: 0, View: 0, Edit: 0 };

async function startAll() {
  stops = [
    await activatePrinting(engine),
    await activateOnshape(engine),
    await activateMouse(engine),
    await activateExtra(engine),
    await activateScrews(screwEngine),
  ];
}

const FILE_EN = [
  "---",
  "Export for Print (3MF)…",
  "Open in OrcaSlicer…",
  "Send to Printer…",
  "Camera…",
  "---",
  "Import from Onshape link\u2026",
];
const VIEW_EN = ["---", "SpaceMouse: Object Mode", "SpaceMouse: Camera Mode", "---", "3D Mouse Settings\u2026"];
const EDIT_EN = ["---", "Parameter Setup…"];

beforeEach(async () => {
  setActivePinia(createPinia());
  localStorage.clear();
  await setLanguage("en");
  for (const m of ["File", "View", "Edit"] as const) base[m] = coreRows(m);
});

afterEach(async () => {
  for (const stop of stops) stop();
  stops = [];
  resetContributions();
  localStorage.clear();
  await reloadLanguageFiles();
  await setLanguage("system");
});

const plugin = (menu: string, f: (m: ReturnType<typeof menuOf>, from: number) => string[]) =>
  f(menuOf(menu), base[menu as "File"]);

describe("plugin menu rows follow the language", () => {
  it("reads English as before, with the same names", async () => {
    await startAll();
    expect(plugin("File", (m, n) => texts(m, n))).toEqual(FILE_EN);
    expect(plugin("View", (m, n) => texts(m, n))).toEqual(VIEW_EN);
    expect(plugin("Edit", (m, n) => texts(m, n))).toEqual(EDIT_EN);
    expect(contributedBodyMenu("body7").map((i) => [i.label, i.refName])).toEqual([
      ["Fastener Specs...", "Fastener Specs..."],
    ]);
    expect(contributedBodyMenu("body2")).toEqual([]);
  });

  it("reads German with English names in the whole plugin part of each menu", async () => {
    await startAll();
    await setLanguage("de");
    expect(plugin("File", (m, n) => texts(m, n))).toEqual([
      "---",
      "Für den Druck exportieren (3MF)…",
      "In OrcaSlicer öffnen…",
      "An den Drucker senden…",
      "Kamera…",
      "---",
      "Von Onshape-Link importieren…",
    ]);
    expect(plugin("File", (m, n) => names(m, n))).toEqual(FILE_EN);
    expect(plugin("View", (m, n) => texts(m, n))).toEqual([
      "---",
      "SpaceMouse: Objektmodus",
      "SpaceMouse: Kameramodus",
      "---",
      "3D-Maus-Einstellungen…",
    ]);
    expect(plugin("View", (m, n) => names(m, n))).toEqual(VIEW_EN);
    expect(plugin("Edit", (m, n) => texts(m, n))).toEqual(["---", "Parameter einrichten…"]);
    expect(plugin("Edit", (m, n) => names(m, n))).toEqual(EDIT_EN);
    expect(contributedBodyMenu("body7").map((i) => [i.label, i.refName])).toEqual([
      ["Verbindungselement-Daten...", "Fastener Specs..."],
    ]);
  });

  it("switches de then fr without activating again", async () => {
    await startAll();
    await setLanguage("de");
    expect(plugin("Edit", (m, n) => texts(m, n))).toEqual(["---", "Parameter einrichten…"]);
    await setLanguage("fr");
    expect(plugin("Edit", (m, n) => texts(m, n))).toEqual(["---", "Configuration des paramètres…"]);
    expect(plugin("File", (m, n) => texts(m, n))).toEqual([
      "---",
      "Exporter pour l'impression (3MF)…",
      "Ouvrir dans OrcaSlicer…",
      "Envoyer à l'imprimante…",
      "Caméra…",
      "---",
      "Importer depuis un lien Onshape…",
    ]);
    expect(plugin("File", (m, n) => names(m, n))).toEqual(FILE_EN);
  });

  it("reads the other shipped languages too, and tells them apart", async () => {
    await startAll();
    const seen: string[] = [];
    for (const code of ["es", "ja", "zh-CN"]) {
      await setLanguage(code);
      seen.push(...plugin("View", (m, n) => texts(m, n)).filter((s) => s !== "---"));
    }
    expect(seen).toEqual([
      "SpaceMouse: modo de objeto",
      "SpaceMouse: modo de cámara",
      "Ajustes del ratón 3D…",
      "SpaceMouse: オブジェクトモード",
      "SpaceMouse: カメラモード",
      "3D マウスの設定…",
      "SpaceMouse：对象模式",
      "SpaceMouse：相机模式",
      "3D 鼠标设置…",
    ]);
  });

  it("lets a line in the user's file win, and leaves the other plugin rows alone", async () => {
    localStorage.setItem(
      "fundacad.language.dropin.de",
      JSON.stringify({ "FundaCAD.Printing:menu.file.send": "Zum Drucker schicken…", "acme.other:menu.file.send": "X" }),
    );
    await reloadLanguageFiles();
    await startAll();
    await setLanguage("de");
    expect(plugin("File", (m, n) => texts(m, n))).toEqual([
      "---",
      "Für den Druck exportieren (3MF)…",
      "In OrcaSlicer öffnen…",
      "Zum Drucker schicken…",
      "Kamera…",
      "---",
      "Von Onshape-Link importieren…",
    ]);
    expect(plugin("File", (m, n) => names(m, n))).toEqual(FILE_EN);
    await setLanguage("fr");
    expect(plugin("File", (m, n) => texts(m, n))[3]).toBe("Envoyer à l'imprimante…");
  });

  it("falls back to the plugin's English for a line a language file lacks", async () => {
    const shipped = import.meta.glob<Record<string, string>>("../../plugins/FundaCAD.Printing/locales/*.json", {
      eager: true,
      import: "default",
    });
    const copy: Record<string, unknown> = {};
    for (const [path, lines] of Object.entries(shipped)) copy[path.replace(/.*\/locales/, "./locales")] = { ...lines };
    const de = copy["./locales/de.json"] as Record<string, string>;
    delete de["menu.file.camera"];
    const own = pluginText<Record<string, string>>("FundaCAD.Printing", copy);
    await setLanguage("de");
    expect([own.t("menu.file.camera"), own.t("menu.file.send")]).toEqual(["Camera…", "An den Drucker senden…"]);
    expect(shipped["../../plugins/FundaCAD.Printing/locales/de.json"]!["menu.file.camera"]).toBe("Kamera…");
  });
});
