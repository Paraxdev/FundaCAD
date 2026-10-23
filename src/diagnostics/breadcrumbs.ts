// Ring buffer of recent events for the bug reporter, fed from window errors and every toast.

import { isSessionEnded } from "../document/session";

const MAX = 20;
const buf: string[] = [];

// Sticky facts (the HID inventory) live outside the ring so twenty toasts cannot evict them.
// They carry no "HH:MM:SS " prefix, which is what tells the two kinds apart in a pasted report.
const STICKY_MAX = 24;
const sticky: string[] = [];

// The log file outlives the window, so crumbs survive a crash. One shared import keeps lines in order.
let core: Promise<typeof import("@tauri-apps/api/core")> | null = null;
function toAppLog(line: string) {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  core ??= import("@tauri-apps/api/core");
  core.then(({ invoke }) => invoke("log_line", { line })).catch(() => {});
}

/** To the log file only: a line that must not take a place in the report's 20 crumbs. */
export function appLog(line: string) {
  toAppLog(line);
}

export function stickyFact(message: string) {
  toAppLog(message.slice(0, 300));
  if (sticky.length >= STICKY_MAX) return;
  sticky.push(message.slice(0, 300));
}

export function crumb(message: string) {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  const line = `${ts} ${message}`.slice(0, 300);
  toAppLog(line);
  buf.push(line);
  if (buf.length > MAX) buf.shift();
}

export function breadcrumbs(): string[] {
  return [...sticky, ...buf];
}

// Guarded so the module imports without a DOM: there is no jsdom in the test setup.
if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => {
    crumb(`[error] ${e.message} (${e.filename ?? "?"}:${e.lineno ?? "?"})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    if (isSessionEnded(r)) return;
    crumb(`[unhandledrejection] ${r instanceof Error ? r.message : String(r)}`);
  });
}
