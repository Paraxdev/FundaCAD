// The app's own log, every error, warning and notice, kept whole.
//
// Every other place an error surfaces shortens it. A toast is one line with
// text-overflow: ellipsis and the status pill is narrower still, so "Fillet failed
// on Body1: Failed creating a chamfer, try a smaller length value(s)" arrives as
// "Fillet failed on Body1: Failed cr...", the part that got cut is the part that
// says what to do, and for a geometry kernel that sentence is often the only
// diagnosis anyone gets. Nothing here ever truncates, the panel wraps rather than
// clips, and an entry can be copied verbatim.
//
// Module-level rather than Pinia, same shape as ui/theme.ts and ui/icons.ts:
// logging has to work from places with no component and no active pinia (a window
// error handler, a worker callback, module initialisation), and a store would make
// the earliest and most interesting failures the ones it could not record.

export type LogLevel = "error" | "warning" | "info";

export interface LogEntry {
  /** Monotonic within a session; the key a list renders by. */
  id: number;
  level: LogLevel;
  /** Wall-clock ms. Rendered as a time, kept as a number so it can be sorted
   *  and diffed without reparsing. */
  at: number;
  /** The whole message. Never shortened, here or downstream. */
  message: string;
  /** Where it came from, "rebuild", "sidecar", "window", a feature id. Shown
   *  as a tag so a wall of kernel errors can be told apart at a glance. */
  source?: string;
  /** Anything longer that belongs with it: a stack, a payload, a feature JSON.
   *  Collapsed by default in the panel. */
  detail?: string;
}

/** How many entries to keep.
 *
 *  A rebuild that fails on every frame of a drag can emit a message per frame,
 *  so this is a ring rather than a list, an unbounded log would turn a
 *  misbehaving preview into a memory leak, and the oldest entries are the least
 *  useful ones anyway. 500 is far more than a session's worth of real errors and
 *  still small enough to render without virtualising. */
export const LOG_LIMIT = 500;

let entries: LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** Newest last, so a panel can render it in order and scroll to the bottom. */
export function logEntries(): readonly LogEntry[] {
  return entries;
}

export function onLogChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Coerce whatever a caller has to a string worth reading.
 *
 *  Error objects are the common case and `String(err)` on one gives
 *  "Error: ...", which is fine; a bare object gives "[object Object]", which is
 *  not, so those are JSON'd. A logger that can turn a real failure into
 *  "[object Object]" is worse than no logger, because it destroys the evidence
 *  while looking like it captured it. */
export function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ? `${value.message}\n${value.stack}` : value.message;
  if (value == null) return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

export function log(
  level: LogLevel,
  message: unknown,
  opts: { source?: string; detail?: unknown } = {},
): LogEntry {
  const entry: LogEntry = {
    id: nextId++,
    level,
    at: Date.now(),
    message: describe(message),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.detail !== undefined ? { detail: describe(opts.detail) } : {}),
  };
  entries = entries.length >= LOG_LIMIT
    ? [...entries.slice(entries.length - LOG_LIMIT + 1), entry]
    : [...entries, entry];
  emit();
  return entry;
}

export const logError = (m: unknown, o?: { source?: string; detail?: unknown }) => log("error", m, o);
export const logWarning = (m: unknown, o?: { source?: string; detail?: unknown }) => log("warning", m, o);
export const logInfo = (m: unknown, o?: { source?: string; detail?: unknown }) => log("info", m, o);

export function clearLog() {
  entries = [];
  emit();
}

export function countByLevel(level: LogLevel): number {
  let n = 0;
  for (const e of entries) if (e.level === level) n++;
  return n;
}

/** One entry as plain text, for the clipboard. */
export function formatEntry(e: LogEntry): string {
  const t = new Date(e.at).toISOString();
  const tag = e.source ? ` [${e.source}]` : "";
  const head = `${t} ${e.level.toUpperCase()}${tag}: ${e.message}`;
  return e.detail ? `${head}\n${e.detail}` : head;
}

/** The whole log as plain text, what the copy-all button hands over. */
export function formatLog(list: readonly LogEntry[] = entries): string {
  return list.map(formatEntry).join("\n\n");
}

// --- the panel's own open/closed state -------------------------------------
// Kept here rather than in a UI store so that the code which decides to OPEN the
// console (a window error handler, say) can do so without reaching for pinia.

let open = false;

export function consoleOpen(): boolean {
  return open;
}

export function setConsoleOpen(next: boolean) {
  if (open === next) return;
  open = next;
  emit();
}

export function toggleConsole() {
  setConsoleOpen(!open);
}
