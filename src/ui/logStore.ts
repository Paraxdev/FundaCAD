// The app's log, kept whole: toasts and the status pill truncate, and the cut part of a kernel error is often the only
// diagnosis. Module-level, not Pinia, so a window error handler, a worker or module init can log too.

export type LogLevel = "error" | "warning" | "info";

export interface LogEntry {
  /** Monotonic within a session; the key a list renders by. */
  id: number;
  level: LogLevel;
  /** Wall-clock ms. */
  at: number;
  /** The whole message. Never shortened, here or downstream. */
  message: string;
  /** Where it came from, "rebuild", "engine", "window", a feature id. Shown
   *  as a tag so a wall of kernel errors can be told apart at a glance. */
  source?: string;
  /** Anything longer that belongs with it: a stack, a payload, a feature JSON.
   *  Collapsed by default in the panel. */
  detail?: string;
}

/** A ring, since a rebuild failing on every drag frame logs once per frame. 500 is far more than a session's real
 *  errors and renders without virtualising. */
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

/** Plain objects are JSON'd: "[object Object]" would destroy the evidence while looking like it captured it. */
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

export function log(level: LogLevel, message: unknown, opts: { source?: string; detail?: unknown } = {}): LogEntry {
  const entry: LogEntry = {
    id: nextId++,
    level,
    at: Date.now(),
    message: describe(message),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.detail !== undefined ? { detail: describe(opts.detail) } : {}),
  };
  entries =
    entries.length >= LOG_LIMIT ? [...entries.slice(entries.length - LOG_LIMIT + 1), entry] : [...entries, entry];
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

// The console's open state lives here so code without pinia, such as a window error handler, can open it.

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

let revealed: number | null = null;

/** The entry the console should scroll to, expand and flash, once. */
export function revealedEntry(): number | null {
  return revealed;
}

export function revealEntry(id: number) {
  revealed = id;
  open = true;
  emit();
}

export function clearRevealed() {
  revealed = null;
}
