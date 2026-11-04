export const SEE_CONSOLE = "The details are in the console.";

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

/** The first line of a rejection when it reads as a sentence, otherwise the fallback. The raw text belongs in the console detail. */
export function plainError(err: unknown, fallback: string): string {
  const first = rawText(err)
    .trim()
    .replace(/^Error:\s*/, "")
    .split("\n")[0];
  const text = (first ?? "").trim();
  return text && !looksInternal(text) ? text : fallback;
}
