// A plugin ships its own language files and reads only its own lines. Each line is looked up in the user's file
// (`<id>:<key>`), then the plugin's file for the language, its base language, then the plugin's English, then the key.
// A plugin's files are untrusted, so a bad file or line is dropped and the next source is used, nothing throws.

import { argNames, formatMessage, parseMessage, type MessageArgs, type MessageNode } from "./format";
import { LANGUAGE_CODE, PSEUDO } from "./languages";
import { MAX_OVERRIDE_BYTES, MAX_PLUGIN_LINES, PLUGIN_LINE_KEY, checkLine } from "./overrides";
import { pseudoNodes } from "./pseudo";

export interface PluginText<K extends string> {
  t(key: K, args?: MessageArgs): string;
  tEnglish(key: K, args?: MessageArgs): string;
}

export interface PluginLinesView {
  active(): { code: string; bcp47: string };
  pluginDropIn(): ReadonlyMap<string, string>;
}

type Lines = ReadonlyMap<string, string>;

const FILE_PATH = /(?:^|\/)([^/]+)\.json$/;

function readFile(id: string, code: string, data: unknown, english: Lines | undefined): Lines | null {
  if (typeof data === "function") {
    console.warn(`the ${code} language file of ${id} is not loaded, import the locales glob with { eager: true }`);
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    console.warn(`the ${code} language file of ${id} is not a JSON object, it is ignored`);
    return null;
  }
  const entries = Object.entries(data);
  if (entries.length > MAX_PLUGIN_LINES || new TextEncoder().encode(JSON.stringify(data)).length > MAX_OVERRIDE_BYTES) {
    console.warn(`the ${code} language file of ${id} is too large, it is ignored`);
    return null;
  }
  const lines = new Map<string, string>();
  const dropped: string[] = [];
  for (const [key, value] of entries) {
    const base = english?.get(key);
    if (!PLUGIN_LINE_KEY.test(key) || typeof value !== "string" || checkLine(value, base) !== null) dropped.push(key);
    else lines.set(key, value);
  }
  if (dropped.length) console.warn(`lines of the ${code} language file of ${id} were dropped`, dropped.slice(0, 20));
  return lines;
}

export function createPluginText(view: PluginLinesView) {
  return function pluginText<E extends Record<string, string>>(
    id: string,
    files: Record<string, unknown>,
  ): PluginText<keyof E & string> {
    const prefix = `${id.toLowerCase()}:`;
    let byCode: Map<string, Lines> | undefined;
    let englishLines: Lines = new Map();
    const parsed = new Map<string, MessageNode[] | null>();
    let seen: Lines | undefined;

    function load(): Map<string, Lines> {
      if (byCode) return byCode;
      const raw = new Map<string, unknown>();
      for (const [path, data] of Object.entries(files)) {
        const code = FILE_PATH.exec(path)?.[1];
        if (code && LANGUAGE_CODE.test(code)) raw.set(code, data);
      }
      byCode = new Map();
      const en = raw.has("en") ? readFile(id, "en", raw.get("en"), undefined) : null;
      if (en) byCode.set("en", (englishLines = en));
      for (const [code, data] of raw) {
        const lines = code === "en" ? null : readFile(id, code, data, englishLines);
        if (lines) byCode.set(code, lines);
      }
      return byCode;
    }

    function compiled(src: string): MessageNode[] | null {
      let nodes = parsed.get(src);
      if (nodes === undefined) {
        try {
          nodes = parseMessage(src);
        } catch {
          nodes = null;
        }
        parsed.set(src, nodes);
      }
      return nodes;
    }

    const englishLine = (key: string, args: MessageArgs = {}): string => {
      load();
      const src = englishLines.get(key);
      const nodes = src === undefined ? null : compiled(src);
      return nodes ? formatMessage(nodes, args, "en") : key;
    };

    function lookup(key: string, args: MessageArgs = {}): string {
      const files = load();
      const a = view.active();
      const dropIn = view.pluginDropIn();
      // A new language or a reloaded file hands out a new map, the old lines are not needed again.
      if (dropIn !== seen) {
        parsed.clear();
        seen = dropIn;
      }
      if (a.code === PSEUDO) {
        const src = englishLines.get(key);
        const nodes = src === undefined ? null : compiled(src);
        return nodes ? formatMessage(pseudoNodes(nodes), args, "en") : key;
      }
      const base = a.code.split("-")[0]!;
      const sources: [string | undefined, boolean][] = [
        [dropIn.get(prefix + key), false],
        [files.get(a.code)?.get(key), false],
        [base === a.code ? undefined : files.get(base)?.get(key), false],
        [englishLines.get(key), true],
      ];
      const allowed = englishLines.has(key) ? argNames(compiled(englishLines.get(key)!) ?? []) : null;
      for (const [src, isEnglish] of sources) {
        if (src === undefined) continue;
        const nodes = compiled(src);
        if (!nodes) continue;
        // A user's line is only text checked, the argument check needs the plugin's English.
        if (allowed && [...argNames(nodes)].some((n) => !allowed.has(n))) continue;
        return formatMessage(nodes, args, a.bcp47, undefined, isEnglish ? "en" : a.bcp47);
      }
      return key;
    }

    return { t: lookup, tEnglish: englishLine };
  };
}
