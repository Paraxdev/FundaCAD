import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t, tEnglish } from "../../src/i18n";

afterEach(() => setLanguage("system"));

describe("tEnglish", () => {
  it("gives the English line while the language is German", async () => {
    await setLanguage("de");
    expect(t("menu.file.saveAs")).not.toBe("Save As…");
    expect(tEnglish("menu.file.saveAs")).toBe("Save As…");
    expect(tEnglish("view.command", { view: "top" })).toBe("Top View");
  });

  it("formats an English plural for 0, 1 and 3 under de", async () => {
    await setLanguage("de");
    expect(tEnglish("prefs.language.inUse", { n: 0 })).toBe("No line of your file is in use.");
    expect(tEnglish("prefs.language.inUse", { n: 1 })).toBe("1 line of your file is in use.");
    expect(tEnglish("prefs.language.inUse", { n: 3 })).toBe("3 lines of your file are in use.");
  });

  it("returns the key for a line English does not have", () => {
    expect(tEnglish("no.suchLine" as never)).toBe("no.suchLine");
  });

  it("follows no language, so a switch back changes nothing", async () => {
    const before = tEnglish("menu.edit.delete");
    await setLanguage("fr");
    expect(tEnglish("menu.edit.delete")).toBe(before);
  });
});
