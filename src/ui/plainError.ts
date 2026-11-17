import { t, tEnglish } from "../i18n";
import { shownLine } from "./englishLines";
import { numberedName } from "./featureMeta";
import type { Feature } from "../types";

// English: it closes sentences that are still written in English. A translated sentence takes seeConsole().
export const SEE_CONSOLE = tEnglish("console.seeDetails");
export const seeConsole = (): string => t("console.seeDetails");

const INTERNAL: readonly RegExp[] = [
  /\b(?:Type|Reference|Syntax|Range|Eval|URI|Internal)Error\b/,
  /^\s*at\s.+\S+:\d+:\d+/m,
  /\[object \w+\]/,
  /\b(?:is|are) (?:undefined|not defined|not a function|not iterable)\b/,
  /\bCannot (?:read|set|destructure) propert/i,
  /\b(?:Standard|StdFail|TopoDS|TopExp|TopAbs|BRep[A-Za-z]*|Geom(?:2d|API|Abs|Lib)?|BOPAlgo|ShapeFix|ShapeAnalysis|IntTools|gp)_[A-Z]\w*/,
  /^\s*[[{]\s*"/,
  /\bpanicked\b|RUST_BACKTRACE|\bunwrap\(\)|\b\w+::\w+/,
];

function rawText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return "";
}

export function looksInternal(text: string): boolean {
  return INTERNAL.some((re) => re.test(text));
}

/** The first line of a rejection when it reads as a sentence, as it was written, otherwise the fallback. */
export function plainEnglish(err: unknown, fallback: string): string {
  const first = rawText(err)
    .trim()
    .replace(/^Error:\s*/, "")
    .split("\n")[0];
  const text = (first ?? "").trim();
  return text && !looksInternal(text) ? text : fallback;
}

/** plainEnglish for a line shown or said, in the chosen language where the app wrote it. The raw text belongs in the
 *  console detail. */
export function plainError(err: unknown, fallback: string): string {
  const text = plainEnglish(err, "");
  return text ? shownLine(text) : fallback;
}

/** The length of the step's first word when the engine's sentence starts with it, as "Fillet: ..." does, else 0. */
export function namesStep(label: string, said: string): number {
  const word = label.split(" ")[0]!;
  const named = said.slice(0, word.length).toLowerCase() === word.toLowerCase() && !/\w/.test(said[word.length] ?? "");
  return named ? word.length : 0;
}

function failedLine(say: typeof t, label: string, english: string, said: string): string {
  if (!said) return say("rebuild.failedNoWhy", { step: label, details: say("console.seeDetails") });
  return namesStep(english, said) ? said : say("rebuild.failed", { step: label, why: said });
}

/** "Fillet failed: <why>", said once when the engine's sentence already starts with the step's name. `english` is the
 *  step's English name, the one that sentence starts with. */
export const failedText = (label: string, raw: unknown, english = label): string =>
  failedLine(t, label, english, plainError(raw, ""));

/** failedText in English, for the problem report. */
export const failedEnglish = (english: string, raw: unknown): string =>
  failedLine(tEnglish, english, english, plainEnglish(raw, ""));

export function sketchConflictText(sketchId: string, features: readonly Feature[]): string {
  const f = features.find((g) => g.id === sketchId);
  return t("params.sketchConflict", { named: f ? "yes" : "no", name: f ? numberedName(f, features) : "" });
}
