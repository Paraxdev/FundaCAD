// Each line is looked up in the user's drop-in file, then the shipped file, then English; a line that fails to parse
// falls to the next. t() reads a shallowRef, so a template or computed that calls it follows a language change.

import { shallowRef } from "vue";
import { formatMessage, parseMessage, type MessageArgs, type MessageNode } from "./format";
import { PSEUDO, PSEUDO_LANGUAGE, isLanguageCode, languageName, matchSystemLanguage, type Language } from "./languages";
import { parseOverrides, type OverrideResult } from "./overrides";
import { pseudoNodes } from "./pseudo";

export const LANGUAGE_KEY = "fundacad.language";
export const DROP_IN_PREFIX = "fundacad.language.dropin.";

/** The lines the catalog itself shows, so an English table without them fails vue-tsc. */
export type CoreKey = "prefs.language.system" | "prefs.language.yours";

export interface DropInSource {
  kind: "folder" | "browser" | "none";
  list(): Promise<string[]>;
  read(code: string): Promise<string | null>;
}

export interface CatalogDeps<K extends string> {
  english: Readonly<Record<K | CoreKey, string>>;
  languages: readonly Language[];
  /** Keyed `./locales/<code>.json`, the shape import.meta.glob gives. */
  loaders: Record<string, () => Promise<{ default: Record<string, string> }>>;
  dropIns: DropInSource;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  systemTags: () => readonly string[];
  dev: boolean;
  setPageLang: (bcp47: string) => void;
  watchSystem?: (onChange: () => void) => void;
}

export interface LanguageChoice {
  value: string;
  label: string;
  lang?: string;
}

export interface DropInStatus {
  lines: number;
  skipped: OverrideResult["skipped"];
  error?: OverrideResult["error"];
}

interface Active {
  code: string;
  bcp47: string;
  shipped: Readonly<Record<string, unknown>>;
  dropIn: ReadonlyMap<string, string>;
  status: DropInStatus | null;
}

export function createCatalog<K extends string>(deps: CatalogDeps<K>) {
  const english: Readonly<Record<string, string>> = deps.english;
  const active = shallowRef<Active>({ code: "en", bcp47: "en", shipped: {}, dropIn: new Map(), status: null });
  const setting = shallowRef("system");
  const dropInCodes = shallowRef<readonly string[]>([]);
  const parsed = new Map<string, MessageNode[] | null>();
  const pseudoParsed = new Map<string, MessageNode[] | null>();
  const listeners = new Set<() => void>();
  let ticket = 0;

  function compiled(src: string): MessageNode[] | null {
    let nodes = parsed.get(src);
    if (nodes === undefined) {
      try {
        nodes = parseMessage(src);
      } catch (e) {
        console.warn("a language line did not parse, the next source is used", e);
        nodes = null;
      }
      parsed.set(src, nodes);
    }
    return nodes;
  }

  function pseudo(key: string): MessageNode[] | null {
    let nodes = pseudoParsed.get(key);
    if (nodes === undefined) {
      const base = english[key] === undefined ? null : compiled(english[key]);
      pseudoParsed.set(key, (nodes = base && pseudoNodes(base)));
    }
    return nodes;
  }

  function lookup(key: string, args: MessageArgs = {}): string {
    const a = active.value;
    if (a.code === PSEUDO) {
      const nodes = pseudo(key);
      return nodes ? formatMessage(nodes, args, "en") : key;
    }
    const shipped = Object.hasOwn(a.shipped, key) ? a.shipped[key] : undefined;
    for (const src of [a.dropIn.get(key), shipped, english[key]]) {
      if (typeof src !== "string") continue;
      const nodes = compiled(src);
      if (nodes) return formatMessage(nodes, args, a.bcp47);
    }
    return key;
  }

  const languageOf = (code: string): Language | undefined =>
    code === PSEUDO ? (deps.dev ? PSEUDO_LANGUAGE : undefined) : deps.languages.find((l) => l.code === code);

  const known = (value: string) =>
    value === "system" || languageOf(value) !== undefined || dropInCodes.value.includes(value);

  function systemCode(): string {
    let tags: readonly string[] = [];
    try {
      tags = deps.systemTags();
    } catch {
      // A missing navigator reads as no OS language.
    }
    return matchSystemLanguage(
      tags,
      deps.languages.filter((l) => l.followsSystem).map((l) => l.code),
    );
  }

  const resolve = (value: string) => (value === "system" ? systemCode() : value);

  async function loadShipped(code: string): Promise<Readonly<Record<string, unknown>>> {
    const loader = deps.loaders[`./locales/${code}.json`];
    if (!loader) return {};
    try {
      return (await loader()).default;
    } catch (e) {
      console.warn(`the ${code} language file did not load, English is shown`, e);
      return {};
    }
  }

  async function loadDropIn(code: string): Promise<OverrideResult | null> {
    if (!isLanguageCode(code)) return null;
    try {
      const text = await deps.dropIns.read(code);
      return text === null ? null : parseOverrides(text, english);
    } catch (e) {
      console.warn(`the user's ${code} language file could not be read`, e);
      return null;
    }
  }

  async function activate(code: string): Promise<void> {
    const mine = ++ticket;
    const [shipped, dropIn] = await Promise.all([loadShipped(code), loadDropIn(code)]);
    if (mine !== ticket) return;
    const bcp47 = languageOf(code)?.bcp47 ?? code;
    const status = dropIn && {
      lines: dropIn.lines.size,
      skipped: dropIn.skipped,
      ...(dropIn.error ? { error: dropIn.error } : {}),
    };
    active.value = { code, bcp47, shipped, dropIn: dropIn?.lines ?? new Map(), status };
    try {
      deps.setPageLang(bcp47);
    } catch {
      // Outside a page there is no lang to set.
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch (e) {
        console.error(e);
      }
    }
  }

  async function listDropIns(): Promise<string[]> {
    try {
      return [...new Set((await deps.dropIns.list()).filter(isLanguageCode))].sort();
    } catch (e) {
      console.warn("the user's language files could not be listed", e);
      return [];
    }
  }

  /** Never rejects: a broken setting, file or folder leaves English. */
  async function init(): Promise<void> {
    dropInCodes.value = await listDropIns();
    let stored: string | null = null;
    try {
      stored = deps.storage?.getItem(LANGUAGE_KEY) ?? null;
    } catch {
      // Blocked storage reads as no setting.
    }
    setting.value = stored !== null && known(stored) ? stored : "system";
    await activate(resolve(setting.value));
  }

  async function setLanguage(next: string): Promise<void> {
    setting.value = known(next) ? next : "system";
    try {
      deps.storage?.setItem(LANGUAGE_KEY, setting.value);
    } catch {
      // The pick still holds until the app closes.
    }
    await activate(resolve(setting.value));
  }

  async function reloadDropIns(): Promise<void> {
    dropInCodes.value = await listDropIns();
    if (!known(setting.value)) setting.value = "system";
    await activate(resolve(setting.value));
  }

  deps.watchSystem?.(() => {
    const code = systemCode();
    if (setting.value === "system" && code !== active.value.code) void activate(code);
  });

  function choices(): LanguageChoice[] {
    const system = languageOf(systemCode())?.native ?? "English";
    const shipped = deps.languages.map((l) => ({
      value: l.code,
      label: l.machine ? `${l.native} (${l.machine})` : l.native,
      lang: l.bcp47,
    }));
    const yours = dropInCodes.value
      .filter((code) => !languageOf(code))
      .map((code) => ({
        value: code,
        label: lookup("prefs.language.yours", { name: languageName(code) }),
        lang: code,
      }));
    const pseudoChoice = deps.dev
      ? [{ value: PSEUDO, label: PSEUDO_LANGUAGE.native, lang: PSEUDO_LANGUAGE.bcp47 }]
      : [];
    return [
      { value: "system", label: lookup("prefs.language.system", { name: system }) },
      ...shipped,
      ...yours,
      ...pseudoChoice,
    ];
  }

  return {
    t: (key: K, args?: MessageArgs): string => lookup(key, args),
    init,
    setLanguage,
    reloadDropIns,
    setting: (): string => setting.value,
    active: (): { code: string; bcp47: string } => ({ code: active.value.code, bcp47: active.value.bcp47 }),
    choices,
    dropInStatus: (): DropInStatus | null => active.value.status,
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
