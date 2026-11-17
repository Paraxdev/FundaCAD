import { t } from "../i18n";

/** The name a document without a file or a name of its own goes by. Code compares against it, so it stays English
 *  and is worded only where it is shown. */
export const UNTITLED = "Untitled";

export const shownFileName = (name: string): string => (name === UNTITLED ? t("document.untitled") : name);
