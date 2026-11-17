import { t } from "../i18n";

/** Names joined the way the language lists them, "a, b, c" in English. */
export function nameList(names: readonly string[]): string {
  return names.length ? names.reduce((before, after) => t("pick.list.more", { before, after })) : "";
}
