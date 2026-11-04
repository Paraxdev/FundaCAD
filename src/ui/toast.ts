// Toast notifications, a bottom-center stack above the timeline, so nothing important happens silently. Errors go to
// the title bar notice (ui/errorNotice.ts) instead. A facade over stores/toasts.ts.

export interface ToastOptions {
  kind?: "error" | "warning" | "info";
  action?: { label: string; onClick: () => void };
  timeout?: number; // ms; errors and toasts with an action default longer
  /** Kept with the console entry, for an error the full report. */
  detail?: unknown;
  source?: string;
  /** An error's announcer key, see showErrorNotice. */
  announceKey?: string;
}

import { crumb } from "../diagnostics/breadcrumbs";
import { log } from "./logStore";
import { useToastStore } from "../stores/toasts";
import { showErrorNotice } from "./errorNotice";
import { announce } from "./announce";

// A screen reader user cannot see the button, so the line names it and where it is.
function spokenLine(message: string, action: ToastOptions["action"]): string {
  if (!action) return message;
  return `${message}${/[.!?]$/.test(message) ? "" : "."} ${action.label} button in Notifications.`;
}

/** The toast's id for `dismissToast`, or null for an error, which is the title bar notice. */
export function toast(message: string, opts: ToastOptions = {}): number | null {
  const kind = opts.kind ?? "info";
  crumb(`[${kind}] ${message}`); // toasts double as bug-report breadcrumbs
  // Every toast is logged whole, not only errors: the warning before a failure often explains it.
  const entry = log(kind, message, { source: opts.source ?? "ui", detail: opts.detail });
  // An error is the title bar notice instead, which opens this entry.
  if (kind === "error") {
    showErrorNotice(message, {
      logId: entry.id,
      action: opts.action,
      holdMs: opts.timeout,
      announceKey: opts.announceKey,
    });
    return null;
  }
  announce(
    spokenLine(message, opts.action),
    kind === "warning" ? "assertive" : "polite",
    opts.announceKey === undefined ? {} : { key: opts.announceKey },
  );
  return useToastStore().push(
    message,
    kind,
    opts.action,
    opts.timeout ?? (opts.action ? 9000 : kind === "warning" ? 6000 : 3500),
  );
}

export function dismissToast(id: number) {
  useToastStore().dismiss(id);
}
