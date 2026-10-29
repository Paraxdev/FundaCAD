import type { EngineWait } from "../geometry/client";
import type { BusyState, RunningOp } from "../document/store";
import { BUILD_PHASE } from "../geometry/buildPhase";

// The timeline's pure helpers, kept apart so they test without a DOM.

// A fast op must not flash a Cancel button; a slow one must offer it early.
export const CANCEL_DELAY_MS = 700;

export interface BuildReport {
  phase: number | null;
  progress: number | null;
  meshed: number | null;
  meshTotal: number | null;
}

/** The chip's words for what the engine, then the app, is doing. `steps` names the features by index. */
export function buildProgress(r: BuildReport, steps: readonly string[]): { label: string; pct: number } {
  const total = steps.length;
  switch (r.phase) {
    case BUILD_PHASE.preparing:
      return { label: "preparing…", pct: 0 };
    case BUILD_PHASE.feature: {
      const at = r.progress ?? -1;
      if (at < 0) return { label: "building…", pct: 0 };
      const n = Math.min(at + 1, total);
      return {
        label: `${steps[at] ?? "building"} ${n}/${total}`,
        pct: total === 0 ? 0 : Math.round((n / total) * 100),
      };
    }
    case BUILD_PHASE.saving:
      return { label: "saving a checkpoint…", pct: 0 };
    case BUILD_PHASE.meshing: {
      if (r.meshed === null || r.meshTotal === null || r.meshTotal <= 0) return { label: "meshing…", pct: 0 };
      const done = Math.min(r.meshed, r.meshTotal);
      const pct = Math.round((done / r.meshTotal) * 100);
      return { label: r.meshTotal === 1 ? "meshing 1 part" : `meshing ${done}/${r.meshTotal} parts`, pct };
    }
    case BUILD_PHASE.assembling:
      return { label: "collecting the result…", pct: 0 };
    case BUILD_PHASE.applying:
      return { label: "applying to the view…", pct: 100 };
    default:
      return { label: "building…", pct: 0 };
  }
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
