// The ribbon button, the panel title, the glossary and the undo toast name Stress with one word per language.
import { describe, expect, it } from "vitest";

type Lines = Record<string, string>;
type Glossary = { terms: { en: string; text: string }[] };

const locales = import.meta.glob<Lines>("../../src/i18n/locales/*.json", { import: "default", eager: true });
const glossaries = import.meta.glob<Glossary>("../../src/i18n/glossary/*.json", { import: "default", eager: true });
const codeOf = (path: string) => path.replace(/^.*\/(.+)\.json$/, "$1");
const byCode = <V>(files: Record<string, V>) =>
  Object.fromEntries(Object.entries(files).map(([p, v]) => [codeOf(p), v]));

function stressWordProblems(files: Record<string, Lines>, glossary: Record<string, Glossary>): string[] {
  return Object.entries(files).flatMap(([code, lines]) => {
    const word = lines["stress.frame.title"]!;
    const problems: string[] = [];
    if (lines["tool.stress"] !== word) problems.push(`${code} button ${lines["tool.stress"]} title ${word}`);
    if (!lines["history.closeStressFirst"]!.includes(word)) problems.push(`${code} toast lacks ${word}`);
    const term = glossary[code]?.terms.find((t) => t.en === "Stress")?.text;
    if (code !== "en" && term !== word) problems.push(`${code} glossary ${term} title ${word}`);
    return problems;
  });
}

describe("the Stress word", () => {
  it("is one word in the button, the panel title, the glossary and the toast, in all six languages", () => {
    const files = byCode(locales);
    expect(Object.keys(files).sort()).toEqual(["de", "en", "es", "fr", "ja", "zh-CN"]);
    expect(stressWordProblems(files, byCode(glossaries))).toEqual([]);
  });

  it("is the one the design names, quoted in the toast", () => {
    const files = byCode(locales);
    expect(
      Object.fromEntries(Object.entries(files).map(([c, l]) => [c, [l["tool.stress"], l["history.closeStressFirst"]]])),
    ).toEqual({
      de: ["Spannung", "Schließen Sie zuerst „Spannung“, dann machen Sie rückgängig."],
      en: ["Stress", "Close Stress first, then undo."],
      es: ["Tensión", "Cierre primero «Tensión» y luego deshaga."],
      fr: ["Contraintes", "Fermez d'abord « Contraintes », puis annulez."],
      ja: ["応力", "先に「応力」を閉じてから、元に戻してください。"],
      "zh-CN": ["应力", "请先关闭“应力”，再撤销。"],
    });
  });

  it("finds a table where the button, the title, the toast or the glossary say another word", () => {
    const made = {
      fr: {
        "tool.stress": "Analyse des contraintes",
        "stress.frame.title": "Contraintes",
        "history.closeStressFirst": "Fermez d'abord l'analyse, puis annulez.",
      },
    };
    const glossary = { fr: { terms: [{ en: "Stress", text: "Analyse des contraintes" }] } };
    expect(stressWordProblems(made, glossary)).toEqual([
      "fr button Analyse des contraintes title Contraintes",
      "fr toast lacks Contraintes",
      "fr glossary Analyse des contraintes title Contraintes",
    ]);
  });
});
