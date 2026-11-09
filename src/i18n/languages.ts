export const PSEUDO = "pseudo";

// Lowercase language, optional Titlecase script, optional region; no separator or dot, so a code can only name a file
// in the languages folder. The Rust read checks the same pattern.
export const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

export function isLanguageCode(s: string): boolean {
  return LANGUAGE_CODE.test(s);
}

export interface Language {
  code: string;
  /** The name in that language, so a person who cannot read the current one still finds theirs. */
  native: string;
  /** "machine translated" in that language, absent once a person has reviewed it. */
  machine?: string;
  bcp47: string;
  /** Whether System may pick it; set once the language covers the whole app, so no OS gets a half translated app. */
  followsSystem: boolean;
}

export const SHIPPED: readonly Language[] = [{ code: "en", native: "English", bcp47: "en", followsSystem: true }];

// en-XA is the reserved BCP 47 tag for pseudo locales.
export const PSEUDO_LANGUAGE: Language = { code: PSEUDO, native: "Pseudo", bcp47: "en-XA", followsSystem: false };

const TRADITIONAL = /^zh-(hant(-.*)?|tw|hk|mo)$/;
const SIMPLIFIED = /^zh(-hans(-.*)?|-cn|-sg)?$/;

/** The first OS language offered; a Traditional Chinese tag ends the search, so it never gets Simplified. */
export function matchSystemLanguage(tags: readonly string[], offered: readonly string[]): string {
  const lower = offered.map((c) => c.toLowerCase());
  for (const raw of tags) {
    const tag = raw.toLowerCase();
    const exact = lower.indexOf(tag);
    if (exact >= 0) return offered[exact]!;
    if (TRADITIONAL.test(tag)) {
      const i = lower.findIndex((c) => TRADITIONAL.test(c));
      return i >= 0 ? offered[i]! : "en";
    }
    if (SIMPLIFIED.test(tag)) {
      const i = lower.findIndex((c) => SIMPLIFIED.test(c));
      if (i >= 0) return offered[i]!;
      continue;
    }
    if (tag.startsWith("zh-")) continue;
    const base = tag.split("-")[0]!;
    const i = lower.indexOf(base);
    if (i >= 0) return offered[i]!;
    const sameBase = lower.findIndex((c) => c.split("-")[0] === base);
    if (sameBase >= 0) return offered[sameBase]!;
  }
  return "en";
}

/** The language's name in its own words, for a language FundaCAD does not ship. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
