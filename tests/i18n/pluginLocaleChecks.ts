import { LANGUAGE_CODE } from "../../src/i18n/languages";
import { MAX_OVERRIDE_BYTES, MAX_PLUGIN_LINES, PLUGIN_LINE_KEY, checkLine } from "../../src/i18n/overrides";
import { usedKeys } from "../../scripts/uiStrings.mjs";

export interface PluginFiles {
  id: string;
  /** Language code to the file's raw text, empty when the plugin has no locales folder. */
  locales: Record<string, string>;
  /** Path to source text of the plugin's own .ts and .vue files. */
  sources: Record<string, string>;
  /** Language codes of the manifest's translations. */
  translated: string[];
}

export const canonical = (lines: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(lines).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2) + "\n";

const eol = (text: string) => text.replace(/\r\n/g, "\n");

function parsed(text: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Every problem of one plugin's language files, as `code: what` lines, empty when it is sound. */
export function pluginProblems(p: PluginFiles): string[] {
  const codes = Object.keys(p.locales);
  if (codes.length === 0) return [];
  const out: string[] = [];
  const english = p.locales.en === undefined ? null : parsed(p.locales.en);
  if (!english) return [p.locales.en === undefined ? "en: missing" : "en: not an object"];
  for (const code of codes) {
    const text = p.locales[code]!;
    if (!LANGUAGE_CODE.test(code)) out.push(`${code}: not a language code`);
    const lines = parsed(text);
    if (!lines) {
      out.push(`${code}: not an object`);
      continue;
    }
    if (new TextEncoder().encode(text).length > MAX_OVERRIDE_BYTES) out.push(`${code}: too many bytes`);
    if (Object.keys(lines).length > MAX_PLUGIN_LINES) out.push(`${code}: too many lines`);
    if (eol(text) !== canonical(lines)) out.push(`${code}: not sorted or not two space indented`);
    for (const key of Object.keys(lines)) {
      if (!PLUGIN_LINE_KEY.test(key)) out.push(`${code}: bad key ${key}`);
      else if (key.startsWith("plugin.")) out.push(`${code}: reserved key ${key}`);
      const value = lines[key];
      const reason = typeof value !== "string" ? "not-text" : checkLine(value, String(english[key] ?? value));
      if (reason) out.push(`${code}: line ${key} is ${reason}`);
    }
    if (code === "en") continue;
    for (const key of Object.keys(english)) if (!Object.hasOwn(lines, key)) out.push(`${code}: missing ${key}`);
    for (const key of Object.keys(lines)) if (!Object.hasOwn(english, key)) out.push(`${code}: extra ${key}`);
  }
  const used = usedKeys(p.sources) as Set<string>;
  for (const key of used) if (!Object.hasOwn(english, key)) out.push(`en: used but absent ${key}`);
  for (const key of Object.keys(english)) if (!used.has(key)) out.push(`en: unused ${key}`);
  const others = codes.filter((c) => c !== "en");
  for (const c of others) if (!p.translated.includes(c)) out.push(`${c}: no manifest translation`);
  for (const c of p.translated) if (!others.includes(c)) out.push(`${c}: manifest translation without a language file`);
  return out;
}

/** The `group.*` lines two plugins give different words for in the same language. */
export function groupDisagreements(plugins: PluginFiles[]): string[] {
  const seen = new Map<string, { id: string; value: unknown }>();
  const out: string[] = [];
  for (const p of plugins) {
    for (const [code, text] of Object.entries(p.locales)) {
      for (const [key, value] of Object.entries(parsed(text) ?? {})) {
        if (!key.startsWith("group.")) continue;
        const at = `${code} ${key}`;
        const first = seen.get(at);
        if (!first) seen.set(at, { id: p.id, value });
        else if (first.value !== value) out.push(`${at}: ${first.id} and ${p.id} differ`);
      }
    }
  }
  return out;
}
