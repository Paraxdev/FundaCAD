// Lightweight toast notifications, a bottom-center stack above the timeline.
// The one job: make sure nothing important can happen SILENTLY. A committed
// feature that fails in the rebuild used to show only a small status line while
// the model stayed visually unchanged, indistinguishable from "nothing
// happened". Errors persist longer and carry an optional action button
// ("Show" → select the failing feature).
//
// This is now a facade over stores/toasts.ts, rendered by
// components/overlays/ToastStack.vue. `toast(message, opts)` keeps its exact
// signature, so all ~40 call sites are untouched.

export interface ToastOptions {
  kind?: "error" | "warning" | "info";
  action?: { label: string; onClick: () => void };
  timeout?: number; // ms; errors default longer
}

import { crumb } from "../diagnostics/breadcrumbs";
import { log } from "./logStore";
import { useToastStore } from "../stores/toasts";

export function toast(message: string, opts: ToastOptions = {}) {
  const kind = opts.kind ?? "info";
  crumb(`[${kind}] ${message}`); // toasts double as bug-report breadcrumbs
  // The toast itself is one clipped line and then it disappears. The log keeps
  // the sentence whole and keeps it around, which for a kernel error is the
  // difference between a diagnosis and "something went wrong". Every toast is
  // recorded rather than only the errors: the warning that preceded a failure is
  // routinely the one that explains it.
  log(kind, message, { source: "ui" });
  useToastStore().push(
    message,
    kind,
    opts.action,
    opts.timeout ?? (kind === "error" ? 8000 : kind === "warning" ? 6000 : 3500),
  );
}
