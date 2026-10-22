import { toast } from "../ui/toast";
import { describe } from "../ui/logStore";

/** Logs and toasts any uncaught error or rejection, so a failure never leaves just a blank viewport. */
export function installGlobalErrorHandlers(): void {
  const headline = (v: unknown) => {
    const m = v instanceof Error ? v.message : typeof v === "string" ? v : "";
    return m ? `Unexpected error: ${m.split("\n")[0]}` : "Unexpected error";
  };
  const agent = typeof navigator === "undefined" ? "" : `\n\nPlatform: ${navigator.userAgent}`;
  window.addEventListener("unhandledrejection", (e) => {
    console.error("Unhandled rejection:", e.reason);
    toast(headline(e.reason), {
      kind: "error",
      source: "promise",
      detail: `Unhandled promise rejection\n\n${describe(e.reason)}${agent}`,
    });
  });
  window.onerror = (message, source, lineno, colno, error) => {
    console.error("Uncaught error:", error ?? message, source, lineno, colno);
    toast(headline(error ?? message), {
      kind: "error",
      source: "window",
      detail: `Uncaught error at ${source ?? "?"}:${lineno ?? "?"}:${colno ?? "?"}\n\n${describe(error ?? message)}${agent}`,
    });
  };
}
