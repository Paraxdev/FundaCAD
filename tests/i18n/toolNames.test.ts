import { describe, expect, it } from "vitest";
import en from "../../src/i18n/locales/en.json";
import de from "../../src/i18n/locales/de.json";
import es from "../../src/i18n/locales/es.json";
import fr from "../../src/i18n/locales/fr.json";
import ja from "../../src/i18n/locales/ja.json";
import zhCN from "../../src/i18n/locales/zh-CN.json";

type Table = Record<string, string>;

// Everything the rail shows by name: tools, families, groups and its own buttons.
const RAIL_NAMES = new Set([
  "rail.construction",
  "rail.deselectAll",
  "rail.exitSketching",
  "rail.isolate",
  "rail.newSketch",
  "rail.search",
  "rail.sectionView",
]);
const isToolName = (key: string) => key.startsWith("tool.") || RAIL_NAMES.has(key);

// "Circular Pat." is the short label of "Circular Pattern", one tool under two lengths.
const sameName = (a: string, b: string) =>
  a === b || (a.endsWith(".") && b.startsWith(a.slice(0, -1))) || (b.endsWith(".") && a.startsWith(b.slice(0, -1)));

// A family on the rail is a group folded into one button, so the two may share a word (ja 拘束 for both).
const familyAndGroup = (a: string, b: string) =>
  (a.startsWith("tool.family.") && b.startsWith("tool.group.")) ||
  (a.startsWith("tool.group.") && b.startsWith("tool.family."));

// Two tools with different English names that one language gives the same word, as "a | b | word".
function collisions(english: Table, lang: Table): string[] {
  const byText = new Map<string, string[]>();
  for (const key of Object.keys(english).filter(isToolName)) {
    const text = lang[key]!;
    const keys = byText.get(text) ?? [];
    if (!keys.some((k) => sameName(english[k]!, english[key]!) || familyAndGroup(k, key))) keys.push(key);
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
    const grouped = { ...english, "tool.group.constraints": "Constraints", "tool.stress": "Stress" };
    expect(
      collisions(grouped, { ...grouped, "tool.group.constraints": "Contraintes", "tool.stress": "Contraintes" }),
    ).toEqual(["tool.group.constraints | tool.stress | Contraintes"]);
    const button = { ...english, "rail.isolate": "Isolate", "tool.separate": "Separate", "rail.title": "Tools" };
    expect(collisions(button, { ...button, "rail.isolate": "分離", "tool.separate": "分離" })).toEqual([
      "rail.isolate | tool.separate | 分離",
    ]);
    expect(collisions(button, { ...button, "rail.title": "Joint", "tool.joint": "Joint" })).toEqual([]);
    const folded = { ...english, "tool.family.constrain": "Constrain", "tool.group.constraints": "Constraints" };
    expect(
      collisions(folded, { ...folded, "tool.family.constrain": "拘束", "tool.group.constraints": "拘束" }),
    ).toEqual([]);
    expect(collisions(folded, { ...folded, "tool.family.constrain": "拘束", "tool.union": "拘束" })).toEqual([
      "tool.union | tool.family.constrain | 拘束",
    ]);
  });
});
