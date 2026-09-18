// Lightweight toast notifications, a bottom-center stack above the timeline.
// The one job: make sure nothing important can happen SILENTLY. A committed
// feature that fails in the rebuild used to show only a small status line while
// the model stayed visually unchanged, indistinguishable from "nothing
// happened". Errors go to the title bar notice (ui/errorNotice.ts) instead of
// this stack, with their optional action ("Show" selects the failing feature).
//
// This is now a facade over stores/toasts.ts, rendered by
// components/overlays/ToastStack.vue. `toast(message, opts)` keeps its exact
// signature, so all ~40 call sites are untouched.

export interface ToastOptions {
  kind?: "error" | "warning" | "info";
  action?: { label: string; onClick: () => void };
  timeout?: number; // ms; errors default longer
  /** Kept with the console entry, for an error the full report. */
  detail?: unknown;
  source?: string;
}

import { crumb } from "../diagnostics/breadcrumbs";
import { log } from "./logStore";
import { useToastStore } from "../stores/toasts";
import { showErrorNotice } from "./errorNotice";

export function toast(message: string, opts: ToastOptions = {}) {
  const kind = opts.kind ?? "info";
  crumb(`[${kind}] ${message}`); // toasts double as bug-report breadcrumbs
  // The toast itself is one clipped line and then it disappears. The log keeps
  // the sentence whole and keeps it around, which for a kernel error is the
  // difference between a diagnosis and "something went wrong". Every toast is
  // recorded rather than only the errors: the warning that preceded a failure is
  // routinely the one that explains it.
  const entry = log(kind, message, { source: opts.source ?? "ui", detail: opts.detail });
  // An error is the title bar notice instead, which opens this entry.
  if (kind === "error") {
    showErrorNotice(message, { logId: entry.id, action: opts.action, holdMs: opts.timeout });
    return;
  }
  useToastStore().push(
    message,
    kind,
    opts.action,
    opts.timeout ?? (kind === "warning" ? 6000 : 3500),
  );
}
