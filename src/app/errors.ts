import { toast } from "../ui/toast";
import { describe } from "../ui/logStore";

/** Last-resort net: an uncaught error/rejection anywhere shouldn't fail silently
 *  with just a blank viewport, log it and tell the user something broke.
 *
 *  Called from main.ts before anything else is constructed, so a failure inside
 *  engine construction itself still surfaces. */
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
