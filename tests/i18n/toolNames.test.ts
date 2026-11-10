import { describe, expect, it } from "vitest";
import en from "../../src/i18n/locales/en.json";
import de from "../../src/i18n/locales/de.json";
import es from "../../src/i18n/locales/es.json";
import fr from "../../src/i18n/locales/fr.json";
import ja from "../../src/i18n/locales/ja.json";
import zhCN from "../../src/i18n/locales/zh-CN.json";

type Table = Record<string, string>;

const isToolName = (key: string) =>
  key.startsWith("tool.") && !key.startsWith("tool.group.") && !key.startsWith("tool.family.");

// "Circular Pat." is the short label of "Circular Pattern", one tool under two lengths.
const sameName = (a: string, b: string) =>
  a === b || (a.endsWith(".") && b.startsWith(a.slice(0, -1))) || (b.endsWith(".") && a.startsWith(b.slice(0, -1)));

// Two tools with different English names that one language gives the same word, as "a | b | word".
function collisions(english: Table, lang: Table): string[] {
  const byText = new Map<string, string[]>();
  for (const key of Object.keys(english).filter(isToolName)) {
    const text = lang[key]!;
    const keys = byText.get(text) ?? [];
    if (!keys.some((k) => sameName(english[k]!, english[key]!))) keys.push(key);
    byText.set(text, keys);
  }
  return [...byText].filter(([, keys]) => keys.length > 1).map(([text, keys]) => `${keys.join(" | ")} | ${text}`);
}

describe("tool names in a language", () => {
  it.each([
    ["de", de],
    ["es", es],
    ["fr", fr],
    ["ja", ja],
    ["zh-CN", zhCN],
  ])("gives two different tools two different words in %s", (_code, lang) => {
    expect(collisions(en, lang)).toEqual([]);
  });

  it("finds two tools that share a word, and lets one English name share its word", () => {
    const english = { "tool.joint": "Joint", "tool.union": "Union", "tool.scale": "Scale", "tool.scale2": "Scale" };
    expect(collisions(english, { ...english, "tool.joint": "Unión", "tool.union": "Unión" })).toEqual([
      "tool.joint | tool.union | Unión",
    ]);
    expect(collisions(english, { ...english, "tool.scale": "Escalar", "tool.scale2": "Escalar" })).toEqual([]);
    const short = { ...english, "tool.circularPat": "Circular Pat.", "tool.circularPattern": "Circular Pattern" };
    expect(
      collisions(short, { ...short, "tool.circularPat": "Kreismuster", "tool.circularPattern": "Kreismuster" }),
    ).toEqual([]);
    const clipped = { ...english, "tool.offset": "Off.", "tool.circularPattern": "Circular Pattern" };
    expect(collisions(clipped, { ...clipped, "tool.offset": "Muster", "tool.circularPattern": "Muster" })).toEqual([
      "tool.offset | tool.circularPattern | Muster",
    ]);
    const grouped = { ...english, "tool.group.pattern": "Pattern", "tool.family.pattern": "Pattern Family" };
    expect(collisions(grouped, { ...grouped, "tool.group.pattern": "Union", "tool.family.pattern": "Union" })).toEqual(
      [],
    );
  });
});
