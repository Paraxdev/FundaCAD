import type { EngineWait } from "../geometry/client";
import type { BusyState, RunningOp } from "../document/store";

// The timeline's pure helpers, kept apart so they test without a DOM.

// A fast op must not flash a Cancel button; a slow one must offer it early.
export const CANCEL_DELAY_MS = 700;

/** Meshing reports feature = -1 for its whole run (136 s on the reference assembly), so per-body counts give the
 *  real fraction when the engine supplies them, else the label stays indeterminate. */
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
  const who =
    w.who === "assistant"
      ? w.name?.trim().slice(0, 40) || "an AI assistant"
      : w.who === "app"
        ? "the app"
        : "another session";
  return `Waiting: ${who} is ${WAIT_DOING[w.op] ?? "working"}`;
}

/** `pct` null means an indeterminate bar; an op that reports no stages gets no bar. */
export function busyLine(b: Pick<BusyState, "label" | "stage" | "pct" | "waiting">): {
  text: string;
  detail: string | null;
  bar: boolean;
  pct: number | null;
} {
  if (b.waiting) return { text: waitLabel(b.waiting), detail: null, bar: false, pct: null };
  if (b.stage === null) {
    return { text: b.pct === null ? b.label : `${b.label} ${b.pct}%`, detail: null, bar: false, pct: null };
  }
  return { text: b.label, detail: b.pct === null ? b.stage : `${b.stage} ${b.pct}%`, bar: true, pct: b.pct };
}

/** A rebuild of a featureless document has no steps to show while it waits on the engine; an import into one does,
 *  whichever op started last. */
export function historyShowsEmpty(featureCount: number, ops: readonly Pick<RunningOp, "rebuild">[]): boolean {
  return featureCount === 0 && ops.every((o) => o.rebuild);
}

/** The ops History lists as rows of their own; this document's rebuild has the build chip instead. */
export function runningRows<T extends Pick<RunningOp, "rebuild">>(ops: readonly T[]): T[] {
  return ops.filter((o) => !o.rebuild);
}

/** After the delay. An empty document's rebuild is instant and silent, unless it waits behind another client's job. */
export function historyShowsBusy(
  featureCount: number,
  busy: Pick<BusyState, "active" | "waiting">,
  ops: readonly Pick<RunningOp, "rebuild">[],
): boolean {
  return busy.active && (busy.waiting !== null || !historyShowsEmpty(featureCount, ops));
}
