// Opening, saving, importing and exporting read in the chosen language, and the unit lists follow a live switch.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t } from "../../src/i18n";
import { FORMATS, UNITS } from "../../src/io/exportSettings";
import { unitChoices } from "../../src/io/importUnit";
import { describeDropLeftovers, type DropPlan } from "../../src/io/dropRouting";
import { leftOutSectionsNotice } from "../../src/io/documentExt";
import { describeImportCapability } from "../../src/io/files";

afterEach(() => setLanguage("system"));

const labels = (list: readonly { label: string }[]) => list.map((x) => x.label);

const plan = (rejected: string[], skipped: string[]): DropPlan<string> => ({
  open: "a.funda",
  imports: [],
  environments: [],
  skipped,
  rejected,
});

describe("the unit lists", () => {
  it("follow a switch on the same list object and keep their values", async () => {
    const same = UNITS;
    expect(labels(UNITS)).toEqual(["Millimeter", "Centimeter", "Meter", "Inch", "Foot"]);
    await setLanguage("de");
    expect(labels(UNITS)).toEqual(["Millimeter", "Zentimeter", "Meter", "Zoll", "Fuß"]);
    await setLanguage("ja");
    expect(labels(UNITS)).toEqual(["ミリメートル", "センチメートル", "メートル", "インチ", "フィート"]);
    expect(UNITS).toBe(same);
    expect(UNITS.map((u) => u.value)).toEqual(["mm", "cm", "m", "in", "ft"]);
  });

  it("ask for an import unit in the chosen language, the last one first", async () => {
    await setLanguage("de");
    const choices = unitChoices("inch");
    expect(choices[0]).toEqual({ value: "inch", label: "Zoll", hint: "zuletzt verwendet" });
    expect(labels(choices)).toEqual(["Zoll", "Millimeter", "Zentimeter", "Meter"]);
    await setLanguage("ja");
    expect(unitChoices("mm")[0]).toEqual({ value: "mm", label: "ミリメートル", hint: "前回使用" });
  });

  it("keep the export format names and patterns the same in every language", async () => {
    const english = labels(FORMATS);
    await setLanguage("ja");
    expect(labels(FORMATS)).toEqual(english);
  });
});

describe("file notices", () => {
  it("say what a drop left out, singular and plural", async () => {
    await setLanguage("de");
    expect(describeDropLeftovers(plan([], ["b.funda"]), (x) => x)).toBe(
      "Es kann nur ein Dokument gleichzeitig geöffnet sein, daher blieb b.funda geschlossen.",
    );
    expect(describeDropLeftovers(plan(["x.txt"], ["b.funda", "c.funda"]), (x) => x)).toBe(
      "Nicht importiert, FundaCAD kann x.txt nicht lesen. " +
        "Es kann nur ein Dokument gleichzeitig geöffnet sein, daher blieben b.funda, c.funda geschlossen.",
    );
    await setLanguage("ja");
    expect(describeDropLeftovers(plan([], ["b.funda", "c.funda"]), (x) => x)).toBe(
      "一度に開けるドキュメントは 1 つだけのため、b.funda、c.funda は開かれませんでした。",
    );
  });

  it("count the sections a save leaves out", async () => {
    await setLanguage("de");
    expect(leftOutSectionsNotice("a.funda", [{ name: "pins" }])).toBe(
      "Ohne einen Abschnitt (pins) gespeichert, den diese Version von FundaCAD nicht liest. " +
        "Speichern Sie als .fundab, um ihn zu behalten.",
    );
    expect(leftOutSectionsNotice("a.funda", [{ name: "pins" }, { name: "notes" }])).toContain("2 Abschnitte");
    await setLanguage("ja");
    expect(leftOutSectionsNotice("a.funda", [{ name: "pins" }, { name: "notes" }])).toBe(
      "このバージョンの FundaCAD が読み込まないセクション (pins、notes) を除いて保存しました。残すには .fundab として保存してください。",
    );
  });

  it("group a body count the way the language writes it", async () => {
    await setLanguage("de");
    expect(describeImportCapability(1500)).toContain("1500 Körper importiert");
    await setLanguage("ja");
    expect(describeImportCapability(3060)).toContain("3,060 個のボディ");
  });

  it("spell the export summary with its plural", async () => {
    await setLanguage("de");
    expect(t("export.done", { n: 1 })).toBe("1 Datei exportiert");
    expect(t("export.doneWarnings", { n: 3 })).toBe("3 Dateien exportiert, mit Warnungen");
    await setLanguage("ja");
    expect(t("export.done", { n: 2 })).toBe("2 個のファイルをエクスポートしました");
  });
});
