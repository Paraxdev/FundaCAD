import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { spokenUnit } from "../../src/ui/measure";

afterEach(() => setLanguage("system"));

const CAPTIONS = ["N", "MPa", "g/cm³", "ms", "%"];

// [many, one] per caption, in CAPTIONS order
const SAID: Record<string, [string, string][]> = {
  en: [
    ["newtons", "newton"],
    ["megapascals", "megapascal"],
    ["grams per cubic centimetre", "gram per cubic centimetre"],
    ["milliseconds", "millisecond"],
    ["percent", "percent"],
  ],
  de: [
    ["Newton", "Newton"],
    ["Megapascal", "Megapascal"],
    ["Gramm pro Kubikzentimeter", "Gramm pro Kubikzentimeter"],
    ["Millisekunden", "Millisekunde"],
    ["Prozent", "Prozent"],
  ],
  fr: [
    ["newtons", "newton"],
    ["mégapascals", "mégapascal"],
    ["grammes par centimètre cube", "gramme par centimètre cube"],
    ["millisecondes", "milliseconde"],
    ["pour cent", "pour cent"],
  ],
  es: [
    ["newtons", "newton"],
    ["megapascales", "megapascal"],
    ["gramos por centímetro cúbico", "gramo por centímetro cúbico"],
    ["milisegundos", "milisegundo"],
    ["por ciento", "por ciento"],
  ],
  ja: [
    ["ニュートン", "ニュートン"],
    ["メガパスカル", "メガパスカル"],
    ["グラム毎立方センチメートル", "グラム毎立方センチメートル"],
    ["ミリ秒", "ミリ秒"],
    ["パーセント", "パーセント"],
  ],
  "zh-CN": [
    ["牛顿", "牛顿"],
    ["兆帕", "兆帕"],
    ["克每立方厘米", "克每立方厘米"],
    ["毫秒", "毫秒"],
    ["百分比", "百分比"],
  ],
};

describe("spoken unit captions in the chosen language", () => {
  it.each(Object.keys(SAID))("%s says every caption, plural and singular", async (code) => {
    await setLanguage(code);
    expect(CAPTIONS.map((c) => [spokenUnit(c, true), spokenUnit(c, true, true)])).toEqual(SAID[code]);
  });

  it("the symbol comes back when units are not spoken in full, in every language", async () => {
    for (const code of Object.keys(SAID)) {
      await setLanguage(code);
      expect(CAPTIONS.map((c) => spokenUnit(c, false))).toEqual(CAPTIONS);
      expect(CAPTIONS.map((c) => spokenUnit(c, false, true))).toEqual(CAPTIONS);
    }
  });

  it("a measure is said in the language and keeps its symbol, text it does not know comes back as written", async () => {
    await setLanguage("de");
    expect([spokenUnit("in", true), spokenUnit("in", true, true), spokenUnit("in", false)]).toEqual([
      "Zoll",
      "Zoll",
      "in",
    ]);
    expect([spokenUnit("samples", true), spokenUnit("constructor", true), spokenUnit("kN", true, true)]).toEqual([
      "samples",
      "constructor",
      "kN",
    ]);
  });

  it("switching back to English restores the English words", async () => {
    await setLanguage("ja");
    expect(spokenUnit("N", true)).toBe("ニュートン");
    await setLanguage("en");
    expect([spokenUnit("N", true), spokenUnit("N", true, true)]).toEqual(["newtons", "newton"]);
  });
});
