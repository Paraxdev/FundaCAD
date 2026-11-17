const WORDS = /[A-Za-z]{4,}/g;

/** The English words of four or more letters in `english` that a translated render still holds, case aside. */
export function englishLeft(text: string, english: string, allow: readonly string[] = []): string[] {
  const kept = new Set(allow.map((w) => w.toLowerCase()));
  const inEnglish = new Set((english.match(WORDS) ?? []).map((w) => w.toLowerCase()));
  const left = (text.match(WORDS) ?? []).map((w) => w.toLowerCase()).filter((w) => inEnglish.has(w) && !kept.has(w));
  return [...new Set(left)];
}
