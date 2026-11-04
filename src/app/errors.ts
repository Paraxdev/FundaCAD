import { toast } from "../ui/toast";
import { plainError, SEE_CONSOLE } from "../ui/plainError";
import { describe } from "../ui/logStore";
import { isSessionEnded } from "../document/session";
import { isBrowserNotice } from "../diagnostics/browserNotice";

/** Logs and toasts any uncaught error or rejection, so a failure never leaves just a blank viewport. */
export function installGlobalErrorHandlers(): void {
  const headline = (v: unknown) => {
    const m = plainError(v, "");
    return m ? `Unexpected error: ${m}` : `Something went wrong. ${SEE_CONSOLE}`;
  };
  const agent = typeof navigator === "undefined" ? "" : `\n\nPlatform: ${navigator.userAgent}`;
  window.addEventListener("unhandledrejection", (e) => {
    // Work of a closed document is meant to stop this way, it is not a failure.
    if (isSessionEnded(e.reason)) return;
    console.error("Unhandled rejection:", e.reason);
    toast(headline(e.reason), {
      kind: "error",
      source: "promise",
      detail: `Unhandled promise rejection\n\n${describe(e.reason)}${agent}`,
    });
  });
  window.onerror = (message, source, lineno, colno, error) => {
    if (isBrowserNotice(message, error)) return;
    console.error("Uncaught error:", error ?? message, source, lineno, colno);
    toast(headline(error ?? message), {
      kind: "error",
      source: "window",
      detail: `Uncaught error at ${source ?? "?"}:${lineno ?? "?"}:${colno ?? "?"}\n\n${describe(error ?? message)}${agent}`,
    });
  };
}
