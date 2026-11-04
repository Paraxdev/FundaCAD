// Toast notifications, a bottom-center stack above the timeline, so nothing important happens silently. Errors go to
// the title bar notice (ui/errorNotice.ts) instead. A facade over stores/toasts.ts.

type ToastKind = "error" | "warning" | "info";

export interface ToastOptions {
  kind?: ToastKind;
  action?: { label: string; onClick: () => void };
  /** ms, never shorter than the kind's own time, see noticeTime.ts. */
  timeout?: number;
  /** Kept with the console entry, for an error the full report. */
  detail?: unknown;
  source?: string;
  /** An error's announcer key, see showErrorNotice. */
  announceKey?: string;
  /** Shown but not spoken, for a line something else already says. A toast with an action is spoken anyway, so its
   *  button is heard. */
  silent?: boolean;
}

import { crumb } from "../diagnostics/breadcrumbs";
import { log } from "./logStore";
import { useToastStore } from "../stores/toasts";
import { showErrorNotice } from "./errorNotice";
import { announce } from "./announce";
import { noticeHoldMs } from "./noticeTime";

// A screen reader user cannot see the button, so the line names it and where it is.
function spokenLine(message: string, action: ToastOptions["action"]): string {
  if (!action) return message;
  return `${message}${/[.!?]$/.test(message) ? "" : "."} ${action.label} button in Notifications.`;
}

let last: { message: string; kind: ToastKind; id: number | null } | null = null;

function showCopy(message: string, kind: ToastKind): void {
  announce(message, kind === "info" ? "polite" : "assertive");
  useToastStore().push(message, kind, undefined, noticeHoldMs(kind, false));
}

/** The toast's id for `dismissToast`, or null for an error, which is the title bar notice. */
export function toast(message: string, opts: ToastOptions = {}): number | null {
  const kind = opts.kind ?? "info";
  crumb(`[${kind}] ${message}`); // toasts double as bug-report breadcrumbs
  // Every toast is logged whole, not only errors: the warning before a failure often explains it.
  const entry = log(kind, message, { source: opts.source ?? "ui", detail: opts.detail });
  // An error is the title bar notice instead, which opens this entry.
  if (kind === "error") {
    last = { message, kind, id: null };
    showErrorNotice(message, {
      logId: entry.id,
      action: opts.action,
      holdMs: opts.timeout,
      announceKey: opts.announceKey,
    });
    return null;
  }
  if (!opts.silent || opts.action) {
    announce(
      spokenLine(message, opts.action),
      kind === "warning" ? "assertive" : "polite",
      opts.announceKey === undefined ? {} : { key: opts.announceKey },
    );
  }
  const id = useToastStore().push(message, kind, opts.action, noticeHoldMs(kind, !!opts.action, opts.timeout));
  last = { message, kind, id };
  return id;
}

/** Says the newest message again and shows it again. It never becomes the newest message itself. */
export function showLastMessage(): void {
  if (!last) {
    showCopy("No messages yet", "info");
    return;
  }
  const { message, kind, id } = last;
  // A copy carries no button: its closure may point at a step that is gone.
  if (id !== null && useToastStore().restart(id)) {
    announce(message, kind === "info" ? "polite" : "assertive");
    return;
  }
  showCopy(message, kind);
}

export function dismissToast(id: number) {
  useToastStore().dismiss(id);
}
