import { activeLanguage, t } from "../i18n";

export function ago(time: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - time) / 1000));
  if (s < 60) return t("time.ago.now");
  const m = Math.round(s / 60);
  if (m < 60) return t("time.ago.minutes", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("time.ago.hours", { n: h });
  const d = Math.floor(h / 24);
  if (d < 7) return t("time.ago.days", { n: d });
  // A month name, as 11/10/2026 reads as two different days depending on the reader.
  return new Date(time).toLocaleDateString(activeLanguage().bcp47, { day: "numeric", month: "short", year: "numeric" });
}
