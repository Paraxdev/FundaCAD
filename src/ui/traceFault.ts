import { toast } from "./toast";
import { t } from "../i18n";

// A fallback to Realtime is a warning toast: the title bar error notice truncates, so its reason was never read.
export function traceFaultToast(why: string, off: boolean) {
  toast(t("render.traceFault", { why, off: off ? "yes" : "no" }), {
    kind: "warning",
    source: "pathtrace",
    detail: { why, off },
  });
}
