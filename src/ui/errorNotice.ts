// The error notice in the middle of the title bar (ErrorNotice.vue). One at a
// time: a newer error replaces the text and counts, so a burst is one notice
// saying how many, not a stack. Clicking it opens the console on the entry.

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

export interface ErrorNotice {
  /** Changes on every error, the view restarts its timer on it. */
  seq: number;
  message: string;
  /** The console entry holding the full text and report. */
  logId: number;
  /** Errors since the notice last went away, this one included. */
  count: number;
  action?: NoticeAction | undefined;
  holdMs: number;
}

export const DEFAULT_HOLD_MS = 9000;

let current: ErrorNotice | null = null;
let seq = 0;
const listeners = new Set<() => void>();

export function errorNotice(): ErrorNotice | null {
  return current;
}

export function showErrorNotice(
  message: string,
  opts: { logId: number; action?: NoticeAction | undefined; holdMs?: number | undefined },
) {
  current = {
    seq: ++seq,
    message,
    logId: opts.logId,
    count: (current?.count ?? 0) + 1,
    action: opts.action,
    holdMs: opts.holdMs ?? DEFAULT_HOLD_MS,
  };
  for (const fn of listeners) fn();
}

export function dismissErrorNotice() {
  if (!current) return;
  current = null;
  for (const fn of listeners) fn();
}

export function onErrorNotice(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
