// When a harness action has finished: the document, the engine, the tools and
// the picture on screen have all gone quiet.

import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import type { Viewport } from "../viewport/viewport";
import { onLogChange } from "../ui/logStore";
import { HarnessError } from "./locate";

export interface SettleHost {
  store: Pick<DocumentStore, "buildState" | "busyState" | "rebuildPending" | "onBuild" | "onDocChange">;
  geometry: Pick<GeometryBackend, "connected" | "inFlight">;
  viewport: Pick<Viewport, "renderIdle" | "gpuIdle" | "traceStatus">;
}

export interface Quiet {
  open: boolean;
  pending: boolean;
  building: boolean;
  busy: string | null;
  busyPct: number | null;
  inFlight: number;
  renderIdle: boolean;
  gpuIdle: boolean;
  trace: { state: string; samples: number };
}

export function probe(h: SettleHost): Quiet {
  const busy = h.store.busyState;
  const t = h.viewport.traceStatus;
  return {
    open: h.geometry.connected,
    pending: h.store.rebuildPending,
    building: h.store.buildState.building,
    busy: busy.active ? busy.label : null,
    busyPct: busy.active ? busy.pct : null,
    inFlight: h.geometry.inFlight ?? 0,
    renderIdle: h.viewport.renderIdle,
    gpuIdle: h.viewport.gpuIdle,
    trace: { state: t.state, samples: t.samples },
  };
}

export function isQuiet(q: Quiet, trace?: number): boolean {
  const traced = trace == null || (q.trace.state === "done" && q.trace.samples >= trace);
  return q.open && !q.pending && !q.building && !q.busy && q.inFlight === 0 && q.renderIdle && q.gpuIdle && traced;
}

/** One line on what is still going on. */
export function describeQuiet(q: Quiet, trace?: number): string {
  const parts: string[] = [];
  if (q.pending) parts.push("rebuild pending");
  if (q.building) parts.push("building");
  if (q.busy) parts.push(`busy "${q.busy}"${q.busyPct != null ? ` ${Math.round(q.busyPct)}%` : ""}`);
  if (q.inFlight) parts.push(`${q.inFlight} request${q.inFlight === 1 ? "" : "s"} in flight`);
  if (!q.renderIdle) parts.push("drawing");
  else if (!q.gpuIdle) parts.push("GPU still drawing");
  if (trace != null) parts.push(`trace ${q.trace.state} ${q.trace.samples}/${trace} samples`);
  parts.push(q.open ? "socket open" : "socket closed");
  return parts.join(", ");
}

export interface Clock {
  now(): number;
  frame(cb: () => void): void;
}

const realClock: Clock = {
  now: () => performance.now(),
  frame: (cb) => requestAnimationFrame(() => cb()),
};

/** Quiet on this many frames in a row. */
const FRAMES = 3;
/** And nothing changed in the document, the build or the log for this long,
 *  which also covers a tool that schedules its edit a moment after the click. */
const STILL_MS = 150;

export function settle(
  h: SettleHost,
  args: { timeoutMs?: number; trace?: number } = {},
  clock: Clock = realClock,
): Promise<{ ms: number }> {
  const timeout = args.timeoutMs ?? 60_000;
  const start = clock.now();
  let lastEvent = start;
  const bump = () => {
    lastEvent = clock.now();
  };
  const offs = [h.store.onBuild(bump), h.store.onDocChange(bump), onLogChange(bump)];
  lastEvent = start;
  return new Promise((resolve, reject) => {
    let streak = 0;
    const tick = () => {
      const now = clock.now();
      const q = probe(h);
      if (isQuiet(q, args.trace) && now - lastEvent >= STILL_MS) streak++;
      else streak = 0;
      if (streak >= FRAMES) {
        offs.forEach((off) => off());
        resolve({ ms: Math.round(now - start) });
      } else if (now - start > timeout) {
        offs.forEach((off) => off());
        reject(
          new HarnessError(
            `not settled after ${Math.round(timeout / 1000)} s: ${describeQuiet(q, args.trace)}`,
            "SettleTimeout",
          ),
        );
      } else clock.frame(tick);
    };
    clock.frame(tick);
  });
}
