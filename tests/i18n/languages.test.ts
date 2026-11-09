import { describe, expect, it } from "vitest";
import { PSEUDO, SHIPPED, isLanguageCode, languageName, matchSystemLanguage } from "../../src/i18n/languages";

describe("a language code", () => {
  it.each(["pl", "fil", "zh-CN", "zh-Hant-TW", "es-419", "sr-Latn"])("%s names a language file", (code) => {
    expect(isLanguageCode(code)).toBe(true);
  });

  it.each(["PL", "pl_PL", "pl.json", "../de", "de/x", "zh-cn", "x", "abcd", "de-", "pseudo", "", "es-41", "de-at"])(
    "%j is refused",
    (code) => {
      expect(isLanguageCode(code)).toBe(false);
    },
  );

  it("never names the pseudo language", () => {
    expect(isLanguageCode(PSEUDO)).toBe(false);
  });
});

describe("the System language", () => {
  const offered = ["en", "de", "zh-CN", "ja"];
  const pick = (...tags: string[]) => matchSystemLanguage(tags, offered);

  it("takes the base language of a regional tag", () => {
    expect([pick("de-AT"), pick("ja-JP"), pick("de")]).toEqual(["de", "ja", "de"]);
  });

  it("goes down the list past a language not offered", () => {
    expect([pick("fr-CA", "de"), pick("pt-BR", "ko", "ja")]).toEqual(["de", "ja"]);
  });

  it("is English when nothing in the list is offered, or the list is empty", () => {
    expect([pick("pt-BR"), pick("fr-CA", "ko-KR"), pick()]).toEqual(["en", "en", "en"]);
  });

  it("gives Traditional Chinese systems English, even with Simplified second", () => {
    expect([pick("zh-TW", "zh-CN"), pick("zh-HK"), pick("zh-MO", "ja"), pick("zh-Hant-CN"), pick("zh-Hant")]).toEqual([
      "en",
      "en",
      "en",
      "en",
      "en",
    ]);
  });

  it("gives Simplified Chinese to the Simplified tags", () => {
    expect([pick("zh-Hans-TW"), pick("zh"), pick("zh-SG"), pick("zh-CN"), pick("zh-Hans")]).toEqual([
      "zh-CN",
      "zh-CN",
      "zh-CN",
      "zh-CN",
      "zh-CN",
    ]);
  });

  it("goes on past a Simplified tag when Simplified is not offered", () => {
    expect(matchSystemLanguage(["zh-CN", "de-CH"], ["en", "de"])).toBe("de");
  });

  it("gives a Traditional system the Traditional language once one is offered", () => {
    expect(matchSystemLanguage(["zh-HK", "de"], ["en", "zh-TW", "zh-CN"])).toBe("zh-TW");
    expect(matchSystemLanguage(["zh-Hant-MO"], ["en", "zh-CN", "zh-TW"])).toBe("zh-TW");
  });

  it("prefers the exact regional language over the base one", () => {
    expect(matchSystemLanguage(["pt-BR"], ["en", "pt", "pt-BR"])).toBe("pt-BR");
    expect(matchSystemLanguage(["pt-PT"], ["en", "pt-BR", "pt"])).toBe("pt");
    expect(matchSystemLanguage(["pt-PT"], ["en", "pt-BR"])).toBe("pt-BR");
  });

  it("is English for a German system while only English follows System", () => {
    const following = SHIPPED.filter((l) => l.followsSystem).map((l) => l.code);
    expect(following).toEqual(["en"]);
    expect(matchSystemLanguage(["de-DE", "fr"], following)).toBe("en");
  });
});

describe("a language name", () => {
  it("is in the language's own words", () => {
    expect([languageName("pl"), languageName("de")]).toEqual(["polski", "Deutsch"]);
  });

  it("is the code itself when the code is not a language tag", () => {
    expect([languageName("x"), languageName("")]).toEqual(["x", ""]);
  });
});
