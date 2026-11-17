import { toast } from "./toast";
import { t, tEnglish } from "../i18n";

// A fallback to Realtime is a warning toast: the title bar error notice truncates, so its reason was never read.
export function traceFaultToast(why: string, off: boolean, english = why) {
  const said = off ? "yes" : "no";
  toast(t("render.traceFault", { why, off: said }), {
    kind: "warning",
    source: "pathtrace",
    detail: { why: english, off },
    english: tEnglish("render.traceFault", { why: english, off: said }),
  });
}
