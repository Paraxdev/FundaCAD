import { toast } from "./toast";

// A fallback to Realtime is a warning toast: the title bar error notice truncates, so its reason was never read.
export function traceFaultToast(why: string, off: boolean) {
  toast(off ? `${why}. Path tracing is off until FundaCAD restarts.` : `${why}. The view is back on Realtime.`, {
    kind: "warning",
    source: "pathtrace",
    detail: { why, off },
  });
}
