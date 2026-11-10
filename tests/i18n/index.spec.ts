// The app's catalog on a plain page: the setting and the user's files come from localStorage, the lang from the page.
import { describe, expect, it } from "vitest";

describe("the app's catalog in the browser", () => {
  it("is English until init, then the stored language with its file, and back to System", async () => {
    localStorage.clear();
    localStorage.setItem("fundacad.language", "pl");
    localStorage.setItem("fundacad.language.dropin.pl", JSON.stringify({ "prefs.language.title": "Język" }));
    localStorage.setItem("fundacad.language.dropin.nl", "{}");
    document.documentElement.lang = "";
    const i18n = await import("../../src/i18n");
    const english = i18n.t("prefs.language.system", { name: "English" });

    await i18n.initLanguage();
    const polish = [i18n.languageSetting(), document.documentElement.lang, i18n.t("prefs.language.title")];
    const yours = i18n.languageChoices().filter((c) => c.value === "nl" || c.value === "pl" || c.value === "pseudo");

    await i18n.setLanguage("system");
    expect([english, polish, yours, i18n.activeLanguage(), document.documentElement.lang]).toEqual([
      "System (English)",
      ["pl", "pl", "Język"],
      [
        {
          value: "nl",
          label: "Nederlands (your file)",
          parts: [{ text: "Nederlands", lang: "nl" }, { text: " (your file)" }],
        },
        { value: "pl", label: "polski (your file)", parts: [{ text: "polski", lang: "pl" }, { text: " (your file)" }] },
        { value: "pseudo", label: "Pseudo", lang: "en-XA" },
      ],
      { code: "en", bcp47: "en" },
      "en",
    ]);
    expect(localStorage.getItem("fundacad.language")).toBe("system");
  });
});
