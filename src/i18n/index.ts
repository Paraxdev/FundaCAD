// The app's catalog. Until initLanguage runs everything is English, which is what a test that never calls it gets.

import { createCatalog } from "./catalog";
import { pickDropInSource } from "./dropIns";
import { decimalMarkOf, type DecimalMark } from "./format";
import { SHIPPED } from "./languages";
import { createPluginText } from "./pluginLines";
import en from "./locales/en.json";

export type MessageKey = keyof typeof en;
export type { DecimalMark, MessageArgs } from "./format";
export type { PluginText } from "./pluginLines";

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
// The English line whatever the language, for a name a person may also type.
export const tEnglish = catalog.english;
// A translator bound to one plugin's own lines, see docs/I18N.md.
export const pluginText = createPluginText({ active: catalog.active, pluginDropIn: catalog.pluginDropIn });
export const initLanguage = catalog.init;
export const setLanguage = catalog.setLanguage;
export const reloadLanguageFiles = catalog.reloadDropIns;
export const loadLanguageFile = catalog.loadDropInFile;
export const removeLanguageFile = catalog.removeDropIn;
export const openLanguageFolder = catalog.openDropInFolder;
export const languageFileSource = catalog.dropInKind;
export const languageSetting = catalog.setting;
export const activeLanguage = catalog.active;
export const languageMachineTranslated = catalog.machineTranslated;
export const languageChoices = catalog.choices;
export const languageFileStatus = catalog.dropInStatus;
export const languageFilePickedAt = catalog.pickedAt;
export const onLanguageChange = catalog.onChange;
// Reads a shallowRef, so a computed or template that spells a number follows the language.
export const decimalMark = (): DecimalMark => decimalMarkOf(catalog.active().bcp47);
