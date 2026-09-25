import type { EngineWait } from "../geometry/client";
import type { BusyState } from "../document/store";

// The timeline's pure bits, split out so they can be tested without a DOM: how
// long to wait before offering Cancel, what the "building" chip and the busy
// line should say, and when the history is empty.

// A fast op must not flash a Cancel button; a slow one must offer it early.
export const CANCEL_DELAY_MS = 700;

/** Label and bar percentage for the "building" chip.
 *
 *  The meshing (payload) phase reports feature = -1 for its whole duration,
 *  measured at 136 s on the reference assembly, so it used to render as a bar
 *  pinned at 0% under a static "meshing…". When the engine supplies the
 *  per-body counts, show the real fraction; fall back to the indeterminate
 *  label when it can't. */
export function buildProgress(
  progress: number | null,
  meshed: number | null,
  meshTotal: number | null,
  total: number,
): { label: string; pct: number } {
  if (progress === null) return { label: "building…", pct: 0 };
  if (progress < 0) {
    if (meshed === null || meshTotal === null || meshTotal <= 0) {
      return { label: "meshing…", pct: 0 };
    }
    const done = Math.min(meshed, meshTotal);
    return { label: `meshing ${done}/${meshTotal}`, pct: Math.round((done / meshTotal) * 100) };
  }
  return {
    label: `building ${Math.min(progress + 1, total)}/${total}`,
    pct: total === 0 ? 0 : Math.round(((progress + 1) / total) * 100),
  };
}

const WAIT_DOING: Record<string, string> = {
  import: "importing a file",
  rebuild: "building a model",
  computeAll: "building a model",
  export: "exporting",
  exportWith: "exporting",
  inspect: "measuring a model",
};

/** What a request of ours queued behind another client's job is waiting for. */
export function waitLabel(w: EngineWait): string {
  const who = w.who === "assistant"
    ? (w.name?.trim().slice(0, 40) || "an AI assistant")
    : w.who === "app" ? "the app" : "another session";
  return `Waiting: ${who} is ${WAIT_DOING[w.op] ?? "working"}`;
}

/** The history's empty state. A rebuild of a document with no features has
 *  nothing to show even while it waits on the engine; an import into one does. */
export function historyShowsEmpty(featureCount: number, busy: Pick<BusyState, "active" | "rebuild">): boolean {
  return featureCount === 0 && (!busy.active || busy.rebuild);
}
