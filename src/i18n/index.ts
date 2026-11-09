// The app's catalog. Until initLanguage runs everything is English, which is what a test that never calls it gets.

import { createCatalog } from "./catalog";
import { pickDropInSource } from "./dropIns";
import { SHIPPED } from "./languages";
import en from "./locales/en.json";

export type MessageKey = keyof typeof en;
export type { MessageArgs } from "./format";

function pageStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const page = typeof window === "undefined" ? undefined : window;

const catalog = createCatalog<MessageKey>({
  english: en,
  languages: SHIPPED,
  // Each language is its own chunk, loaded when picked.
  loaders: import.meta.glob<{ default: Record<string, string> }>(["./locales/*.json", "!./locales/en.json"]),
  dropIns: pickDropInSource(page, pageStorage()),
  storage: pageStorage(),
  systemTags: () => (typeof navigator === "undefined" ? [] : navigator.languages),
  dev: import.meta.env.DEV,
  setPageLang: (bcp47) => {
    if (typeof document !== "undefined") document.documentElement.lang = bcp47;
  },
  watchSystem: (onChange) => page?.addEventListener("languagechange", onChange),
});

export const t = catalog.t;
export const initLanguage = catalog.init;
export const setLanguage = catalog.setLanguage;
export const reloadLanguageFiles = catalog.reloadDropIns;
export const loadLanguageFile = catalog.loadDropInFile;
export const removeLanguageFile = catalog.removeDropIn;
export const openLanguageFolder = catalog.openDropInFolder;
export const languageFileSource = catalog.dropInKind;
export const languageSetting = catalog.setting;
export const activeLanguage = catalog.active;
export const languageChoices = catalog.choices;
export const languageFileStatus = catalog.dropInStatus;
export const onLanguageChange = catalog.onChange;
