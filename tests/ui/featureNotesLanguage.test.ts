// The note on a placeholder chip follows the chosen language, and names the plugin as the manifest gives it.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import de from "../../src/i18n/locales/de.json";
import en from "../../src/i18n/locales/en.json";
import ja from "../../src/i18n/locales/ja.json";
import { placeholderNote } from "../../src/ui/featureNotes";
import { englishLeft } from "../i18n/englishLeft";

afterEach(async () => {
  await setLanguage("system");
});

const OWNED: [type: string, plugin: string][] = [
  ["texture", "Surface Texture"],
  ["organic", "Node Bodies"],
];

describe("placeholderNote in another language", () => {
  it.each([
    ["de", de],
    ["ja", ja],
  ] as const)("names each owner as given and holds no English in %s", async (code, lines) => {
    await setLanguage(code);
    for (const [type, plugin] of OWNED) {
      const note = placeholderNote(type);
      expect(note).toBe(lines["feature.note.needsPlugin"].replace("{plugin}", plugin));
      expect(englishLeft(note.replace(plugin, ""), en["feature.note.needsPlugin"], ["plugin"])).toEqual([]);
    }
    expect(placeholderNote("texture")).not.toBe(placeholderNote("organic"));
  });

  it.each([
    ["de", de],
    ["ja", ja],
  ] as const)("says no plugin owns the type, in %s", async (code, lines) => {
    await setLanguage(code);
    const note = placeholderNote("futureWidget");
    expect(note).toBe(lines["feature.note.unknownType"]);
    expect(note).not.toBe(en["feature.note.unknownType"]);
    expect(note).not.toContain("futureWidget");
    expect(englishLeft(note, en["feature.note.unknownType"], ["FundaCAD", "version", "feature"])).toEqual([]);
  });

  it("follows a switch back to English without a reload", async () => {
    await setLanguage("de");
    const german = placeholderNote("texture");
    await setLanguage("en");
    expect(placeholderNote("texture")).toBe(en["feature.note.needsPlugin"].replace("{plugin}", "Surface Texture"));
    expect(german).not.toBe(placeholderNote("texture"));
  });
});
