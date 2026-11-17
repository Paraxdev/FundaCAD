import { t } from "../i18n";

/** Two lines said as one. After a stop or a colon only a space, none after a full width one as Japanese and Chinese
 *  write, and the language's own stop between two lines that have none. */
export function joinSaid(before: string, after: string): string {
  if (!before) return after;
  if (/[。！？：]$/.test(before)) return before + after;
  if (/[.!?:]$/.test(before)) return `${before} ${after}`;
  return t("announce.join", { before, after });
}
