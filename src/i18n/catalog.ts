// Each line is looked up in the user's drop-in file, then the shipped file, then English; a line that fails to parse
// falls to the next. t() reads a shallowRef, so a template or computed that calls it follows a language change.

import { shallowRef } from "vue";
import { formatMessage, parseMessage, type MessageArgs, type MessageNode } from "./format";
import { PSEUDO, PSEUDO_LANGUAGE, isLanguageCode, languageName, matchSystemLanguage, type Language } from "./languages";
import { MAX_OVERRIDE_BYTES, parseOverrides, type OverrideResult } from "./overrides";
import { pseudoNodes } from "./pseudo";

export const LANGUAGE_KEY = "fundacad.language";
export const DROP_IN_PREFIX = "fundacad.language.dropin.";
// A slow disk never holds the start back longer than this; Reload reads the folder again.
const START_LIMIT_MS = 2000;

/** The lines the catalog itself shows, so an English table without them fails vue-tsc. */
export type CoreKey = "prefs.language.system" | "prefs.language.yours";

export interface DropInSource {
  kind: "folder" | "browser" | "none";
  list(): Promise<string[]>;
  read(code: string): Promise<string | null>;
  save?(code: string, text: string): Promise<void>;
  remove?(code: string): Promise<void>;
  open?(): Promise<void>;
}

export type DropInFileError = NonNullable<DropInStatus["error"]> | "bad-name" | "unreadable" | "storage" | "folder";

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
  error?: OverrideResult["error"] | "not-read";
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
    const sources = [a.dropIn.get(key), shipped, english[key]];
    for (const [i, src] of sources.entries()) {
      if (typeof src !== "string") continue;
      const nodes = compiled(src);
      // An English line keeps English plurals, or Japanese rules would read "1 lines"; numbers follow the language.
      if (nodes) return formatMessage(nodes, args, a.bcp47, undefined, i === sources.length - 1 ? "en" : a.bcp47);
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

  // A regional file the user adds, as de-AT.json, falls back through its base's shipped file; zh-TW finds no zh.json.
  async function loadShipped(code: string): Promise<Readonly<Record<string, unknown>>> {
    const loader = deps.loaders[`./locales/${code}.json`] ?? deps.loaders[`./locales/${code.split("-")[0]}.json`];
    if (!loader) return {};
    try {
      return (await loader()).default;
    } catch (e) {
      console.warn(`the ${code} language file did not load, English is shown`, e);
      return {};
    }
  }

  // Only a listed file is read, so a language without one costs no read.
  async function loadDropIn(code: string): Promise<Pick<Active, "dropIn" | "status"> | null> {
    if (!dropInCodes.value.includes(code)) return null;
    let result: OverrideResult;
    try {
      const text = await deps.dropIns.read(code);
      if (text === null) return null;
      result = parseOverrides(text, english);
    } catch (e) {
      console.warn(`the user's ${code} language file could not be read`, e);
      return { dropIn: new Map(), status: { lines: 0, skipped: [], error: "not-read" } };
    }
    const { lines, skipped, error } = result;
    return { dropIn: lines, status: { lines: lines.size, skipped, ...(error ? { error } : {}) } };
  }

  async function activate(code: string, late?: Promise<null>): Promise<void> {
    const mine = ++ticket;
    const read = loadDropIn(code);
    const [shipped, dropIn] = await Promise.all([loadShipped(code), late ? Promise.race([read, late]) : read]);
    if (mine !== ticket) return;
    // Started again per language, so the lines of a file read again on Reload do not pile up.
    parsed.clear();
    const bcp47 = languageOf(code)?.bcp47 ?? code;
    active.value = { code, bcp47, shipped, dropIn: dropIn?.dropIn ?? new Map(), status: dropIn?.status ?? null };
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), START_LIMIT_MS)));
    try {
      dropInCodes.value = (await Promise.race([listDropIns(), late])) ?? [];
      let stored: string | null = null;
      try {
        stored = deps.storage?.getItem(LANGUAGE_KEY) ?? null;
      } catch {
        // Blocked storage reads as no setting.
      }
      setting.value = stored !== null && known(stored) ? stored : "system";
      await activate(resolve(setting.value), late);
    } finally {
      clearTimeout(timer);
    }
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

  /** Keeps the file and switches to its language; on an error nothing changes. */
  async function loadDropInFile(file: Pick<File, "name" | "size" | "text">): Promise<DropInFileError | null> {
    const code = file.name.endsWith(".json") ? file.name.slice(0, -".json".length) : "";
    if (!isLanguageCode(code)) return "bad-name";
    // Checked before reading, so a huge file is never pulled into memory.
    if (file.size > MAX_OVERRIDE_BYTES) return "too-large";
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      console.warn("the picked language file could not be read", e);
      return "unreadable";
    }
    const error = parseOverrides(text, english).error;
    if (error) return error;
    if (!deps.dropIns.save) return "storage";
    try {
      await deps.dropIns.save(code, text);
    } catch (e) {
      console.warn("the picked language file could not be kept", e);
      return "storage";
    }
    dropInCodes.value = await listDropIns();
    await setLanguage(code);
    return null;
  }

  async function removeDropIn(): Promise<"storage" | null> {
    if (!deps.dropIns.remove) return "storage";
    try {
      await deps.dropIns.remove(active.value.code);
    } catch (e) {
      console.warn("the user's language file could not be removed", e);
      return "storage";
    }
    dropInCodes.value = await listDropIns();
    // Removing is the user's own step, so a language only the file added is forgotten; a file missing at start is not.
    await (known(setting.value) ? activate(resolve(setting.value)) : setLanguage("system"));
    return null;
  }

  async function openDropInFolder(): Promise<"folder" | null> {
    if (!deps.dropIns.open) return "folder";
    try {
      await deps.dropIns.open();
    } catch (e) {
      console.warn("the user's languages folder could not be opened", e);
      return "folder";
    }
    return null;
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
    loadDropInFile,
    removeDropIn,
    openDropInFolder,
    dropInKind: (): DropInSource["kind"] => deps.dropIns.kind,
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
