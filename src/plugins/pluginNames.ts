// A plugin's name and summary in the chosen language, read live so a switch updates every list at once. The order is
// the user's own `<id>:plugin.name` line, the manifest's text for the language, its base language, then the manifest.

import { activeLanguage, pluginDropInLines } from "../i18n";
import { PSEUDO } from "../i18n/languages";
import { pseudoText } from "../i18n/pseudo";
import type { PluginManifest } from "./manifest";
import { shippedPlugins } from "./shipped";

type Field = "name" | "summary";

function textOf(m: PluginManifest, field: Field): string {
  const { code } = activeLanguage();
  if (code === PSEUDO) return pseudoText(m[field]);
  const mine = pluginDropInLines().get(`${m.id.toLowerCase()}:plugin.${field}`);
  if (mine !== undefined) return mine;
  const own = m.translations.get(code)?.[field] ?? m.translations.get(code.split("-")[0]!)?.[field];
  return own ?? m[field];
}

export const pluginName = (m: PluginManifest): string => textOf(m, "name");
export const pluginSummary = (m: PluginManifest): string => textOf(m, "summary");

/** The shipped plugin's name, or the id when nothing ships under it. */
export function shippedPluginName(id: string): string {
  const found = shippedPlugins().find((p) => p.dir === id);
  return found ? pluginName(found.manifest) : id;
}
