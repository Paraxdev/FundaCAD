import { describe, expect, it } from "vitest";
import { checkLine } from "../../src/i18n/overrides";
import en from "../../src/i18n/locales/en.json";
import enText from "../../src/i18n/locales/en.json?raw";

const KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

const sources = Object.values({
  ...import.meta.glob("../../src/**/*.{vue,ts}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../plugins/**/*.{vue,ts}", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>);

const canonical = (lines: Record<string, string>) =>
  JSON.stringify(Object.fromEntries(Object.entries(lines).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2) + "\n";

const unused = (keys: readonly string[], texts: readonly string[]) =>
  keys.filter((k) => !texts.some((s) => s.includes(`"${k}"`) || s.includes(`'${k}'`)));

const badKeys = (keys: readonly string[]) => keys.filter((k) => !KEY.test(k));

const badLines = (lines: Record<string, string>) =>
  Object.entries(lines).flatMap(([key, value]) => {
    const reason = checkLine(value, value);
    return reason ? [{ key, reason }] : [];
  });

describe("the English file", () => {
  it("names every line area.thing", () => {
    expect(badKeys(Object.keys(en))).toEqual([]);
  });

  it("is sorted by key, two space indented, with a newline at the end", () => {
    expect(enText.replace(/\r\n/g, "\n")).toBe(canonical(en));
  });

  it("holds only lines a dropped in file could hold too", () => {
    expect(badLines(en)).toEqual([]);
  });

  it("holds no line the code never asks for", () => {
    expect(unused(Object.keys(en), sources)).toEqual([]);
  });
});

describe("the checks on the English file", () => {
  it("find a key that is not area.thing", () => {
    expect(badKeys(["stress.setup.title", "Stress.title", "stress", "stress..x", "stress.setup-title"])).toEqual([
      "Stress.title",
      "stress",
      "stress..x",
      "stress.setup-title",
    ]);
  });

  it("find a file out of order", () => {
    const text = '{\n  "stress.b": "B",\n  "stress.a": "A"\n}\n';
    expect(text).not.toBe(canonical(JSON.parse(text)));
    expect(canonical({ "stress.b": "B", "stress.a": "A" })).toBe('{\n  "stress.a": "A",\n  "stress.b": "B"\n}\n');
  });

  it("find markup and broken syntax", () => {
    expect(badLines({ "a.ok": "Fine {n}", "a.markup": "<b>Bold</b>", "a.broken": "Open {" })).toEqual([
      { key: "a.markup", reason: "markup" },
      { key: "a.broken", reason: "syntax" },
    ]);
  });

  it("find a line no source names in quotes", () => {
    const texts = ['t("stress.setup.title")', "t('stress.load.force', { value })", "// stress.setup.faces"];
    expect(unused(["stress.setup.title", "stress.load.force", "stress.setup.faces", "stress.gone"], texts)).toEqual([
      "stress.setup.faces",
      "stress.gone",
    ]);
  });
});
