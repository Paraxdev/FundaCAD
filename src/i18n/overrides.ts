// A dropped in language file is untrusted, anyone can hand one to a user. Markup is refused here rather than at each
// use, because a few panels still build innerHTML.

import { argNames, parseMessage } from "./format";

export const MAX_OVERRIDE_BYTES = 256 * 1024;
export const MAX_LINE_CHARS = 2000;

export type SkipReason =
  "unknown-key" | "not-text" | "too-long" | "markup" | "control-character" | "syntax" | "bad-argument";

export interface OverrideResult {
  /** A Map, so a key named __proto__ is never a property of anything. */
  lines: Map<string, string>;
  skipped: { key: string; reason: SkipReason }[];
  /** Set when the whole file was refused. */
  error?: "too-large" | "not-json" | "not-flat";
}

const MARKUP = /<[A-Za-z/!?]|&(#\d+|#x[0-9a-f]+|[a-z]+);/i;
// C0 and C1 controls, and the bidi overrides and isolates that can make a line read as something else.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

// A skipped key is shown in the card as the file wrote it, so it must not reorder or break the text around it.
export const shownKey = (key: string): string => key.replace(new RegExp(CONTROL, "g"), "\ufffd").slice(0, 80);

export function checkLine(value: string, englishValue: string): SkipReason | null {
  if (value.length > MAX_LINE_CHARS) return "too-long";
  if (MARKUP.test(value)) return "markup";
  if (CONTROL.test(value)) return "control-character";
  let names: Set<string>;
  try {
    names = argNames(parseMessage(value));
  } catch {
    return "syntax";
  }
  const allowed = argNames(parseMessage(englishValue));
  for (const name of names) if (!allowed.has(name)) return "bad-argument";
  return null;
}

export function parseOverrides(text: string, english: Readonly<Record<string, string>>): OverrideResult {
  const result: OverrideResult = { lines: new Map(), skipped: [] };
  // Measured before the BOM goes, so the limit matches the bytes the desktop reads from disk.
  if (new TextEncoder().encode(text).length > MAX_OVERRIDE_BYTES) return { ...result, error: "too-large" };
  let data: unknown;
  try {
    data = JSON.parse(text.startsWith("\ufeff") ? text.slice(1) : text);
  } catch {
    return { ...result, error: "not-json" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ...result, error: "not-flat" };
  const entries = Object.entries(data);
  if (entries.some(([, value]) => value !== null && typeof value === "object")) return { ...result, error: "not-flat" };
  for (const [key, value] of entries) {
    const base = Object.hasOwn(english, key) ? english[key] : undefined;
    let reason: SkipReason | null;
    if (base === undefined) reason = "unknown-key";
    else if (typeof value !== "string") reason = "not-text";
    else reason = checkLine(value, base);
    if (reason) result.skipped.push({ key, reason });
    else result.lines.set(key, value as string);
  }
  return result;
}
