// One log line per committed edit with seconds per stage, for bug reports: the engine's copy, replay, post and mesh
// stages (crates/fundacad-geom/src/cache/timing.rs), the reply size and the app's own commit.

import { appLog } from "./breadcrumbs";

/** Milliseconds, as the engine sends them. */
export interface EngineTiming {
  copy: number;
  replay: number;
  slow: string | null;
  post: number;
  mesh: number;
  meshed: number;
}

export interface EditTiming {
  totalMs: number;
  engine: EngineTiming | null;
  replyBytes: number;
  applyMs: number;
}

const MAX_LINE = 200;

function sec(ms: number): string {
  const s = ms / 1000;
  return s < 0.001 ? "0" : String(Number(s.toPrecision(2)));
}

function size(bytes: number): string {
  return bytes < 1e6 ? `${Math.round(bytes / 1e3)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

export function formatEditTiming(t: EditTiming): string {
  const parts: string[] = [];
  const e = t.engine;
  if (e) {
    const slow = e.slow ? ` (${e.slow.replace(/[^\w-]/g, "").slice(0, 24)})` : "";
    const meshed = e.meshed > 0 ? ` (${e.meshed} ${e.meshed === 1 ? "part" : "parts"})` : "";
    parts.push(
      `copy ${sec(e.copy)}`,
      `replay ${sec(e.replay)}${slow}`,
      `post ${sec(e.post)}`,
      `mesh ${sec(e.mesh)}${meshed}`,
    );
  }
  parts.push(`reply ${size(t.replyBytes)}`, `apply ${sec(t.applyMs)}`);
  return `edit ${sec(t.totalMs)} s: ${parts.join(", ")}`.slice(0, MAX_LINE);
}

export function logEditTiming(t: EditTiming): void {
  appLog(formatEditTiming(t));
}
