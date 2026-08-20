// Diagnostic breadcrumbs: a tiny ring buffer of recent noteworthy events for
// the bug reporter. Fed automatically from window error events and from every
// toast (toast.ts calls crumb() — toasts already are the app's "something
// happened the user should know" channel, which makes them exactly the trail a
// bug triager wants). Never persisted; read once when a report is assembled.

const MAX = 20;
const buf: string[] = [];

// Sticky facts sit OUTSIDE the ring. A one-off captured at startup — the HID
// inventory is the case this exists for — would otherwise be evicted by twenty
// ordinary toasts, i.e. by the user doing anything at all before opening the bug
// reporter. Which is precisely when they'd open it.
//
// A sticky fact carries NO "HH:MM:SS " prefix and an ordinary crumb always does.
// That used to be a cross-language contract, read by a Rust trimmer that kept
// every sticky fact and only the last 20 ordinary ones before uploading a
// report. There is no uploader any more (the reporter copies to the clipboard),
// so the ring below is the only thing enforcing the split. Keep the prefix rule
// anyway: it is what makes the two kinds distinguishable in a pasted report.
const STICKY_MAX = 24;
const sticky: string[] = [];

export function stickyFact(message: string) {
  if (sticky.length >= STICKY_MAX) return;
  sticky.push(message.slice(0, 300));
}

export function crumb(message: string) {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  buf.push(`${ts} ${message}`.slice(0, 300));
  if (buf.length > MAX) buf.shift();
}

export function breadcrumbs(): string[] {
  return [...sticky, ...buf];
}

// Self-installing listeners (imported once from main.ts). Guarded so the module
// stays importable without a DOM — the rest of this codebase keeps its logic
// DOM-free for exactly this reason, and there is no jsdom in the test setup.
if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => {
    crumb(`[error] ${e.message} (${e.filename ?? "?"}:${e.lineno ?? "?"})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    crumb(`[unhandledrejection] ${r instanceof Error ? r.message : String(r)}`);
  });
}
