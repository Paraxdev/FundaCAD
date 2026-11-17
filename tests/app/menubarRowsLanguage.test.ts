import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setLanguage, t } from "../../src/i18n";
import { buildMenus, menuOf, names, row, texts } from "./menuRows";

const FILE = ["Home", "---", "New", "Open…", "---", "Import Mesh…", "---", "Save", "Save As…", "---", "Export…"];
const HELP = [
  "Keyboard Shortcuts",
  "Manual",
  "Accessibility",
  "---",
  "Report a Problem…",
  "Suggest an Idea",
  "Issue Tracker",
  "---",
  "Check for Updates…",
  "About FundaCAD",
];
const EDIT_MIDDLE = ["Delete", "Suppress / Unsuppress", "---", "Materials", "Preferences…"];
const ANALYSIS = ["Overhang", "Zebra", "Curvature", "Body Colors"];

const editMiddle = (m: ReturnType<typeof menuOf>, f: typeof texts) => f(m, 3, 8);
const analysis = (m: ReturnType<typeof menuOf>, f: typeof texts) => f(m, -4);

beforeEach(() => setActivePinia(createPinia()));
afterEach(async () => {
  await setLanguage("system");
});

describe("File, Edit, Help and analysis rows under a language", () => {
  it("read German over English refNames, whole menus", async () => {
    await setLanguage("de");
    const menus = buildMenus();
    expect(texts(menuOf("File", menus))).toEqual([
      "Startseite",
      "---",
      "Neu",
      "Öffnen…",
      "---",
      "Netz importieren…",
      "---",
      "Speichern",
      "Speichern unter…",
      "---",
      "Exportieren…",
    ]);
    expect(names(menuOf("File", menus))).toEqual(FILE);
    expect(editMiddle(menuOf("Edit", menus), texts)).toEqual([
      "Löschen",
      "Unterdrücken / Unterdrückung aufheben",
      "---",
      "Materialien",
      "Einstellungen…",
    ]);
    expect(editMiddle(menuOf("Edit", menus), names)).toEqual(EDIT_MIDDLE);
    expect(texts(menuOf("Help", menus))).toEqual([
      "Tastenkürzel",
      "Handbuch",
      "Barrierefreiheit",
      "---",
      "Problem melden…",
      "Idee vorschlagen",
      "Fehlerliste",
      "---",
      "Nach Updates suchen…",
      "Über FundaCAD",
    ]);
    expect(names(menuOf("Help", menus))).toEqual(HELP);
    expect(analysis(menuOf("View", menus), texts)).toEqual(["Überhang", "Zebra", "Krümmung", "Körperfarben"]);
    expect(analysis(menuOf("View", menus), names)).toEqual(ANALYSIS);
  });

  it("find a row by its English name whatever the language", async () => {
    await setLanguage("de");
    expect(typeof row("File", "Save As…").label).toBe("function");
    expect((row("Help", "Issue Tracker").label as () => string)()).toBe("Fehlerliste");
    expect(row("File", "Speichern")).toBeUndefined();
  });

  it("read English again after switching back, from the same build", async () => {
    await setLanguage("de");
    const menus = buildMenus();
    await setLanguage("system");
    expect(texts(menuOf("File", menus))).toEqual(FILE);
    expect(texts(menuOf("Help", menus))).toEqual(HELP);
    expect(editMiddle(menuOf("Edit", menus), texts)).toEqual(EDIT_MIDDLE);
    expect(analysis(menuOf("View", menus), texts)).toEqual(ANALYSIS);
  });

  it("carry the product name as given, not a fixed one", async () => {
    const about = row("Help", "About FundaCAD").label as () => string;
    expect(about()).toBe("About FundaCAD");
    await setLanguage("de");
    expect(about()).toBe("Über FundaCAD");
    await setLanguage("fr");
    expect(about()).toBe("À propos de FundaCAD");
  });

  it("put any product name into the About line, not a typed in FundaCAD", async () => {
    const lines: string[] = [];
    for (const code of ["system", "de", "fr", "ja"]) {
      await setLanguage(code);
      lines.push(t("menu.help.about", { name: "FundaCAD Dev 2" }));
    }
    expect(lines).toEqual([
      "About FundaCAD Dev 2",
      "Über FundaCAD Dev 2",
      "À propos de FundaCAD Dev 2",
      "FundaCAD Dev 2について",
    ]);
  });
});
