import { toast } from "../ui/toast";

/** Last-resort net: an uncaught error/rejection anywhere shouldn't fail silently
 *  with just a blank viewport, log it and tell the user something broke.
 *
 *  Called from main.ts before anything else is constructed, so a failure inside
 *  engine construction itself still surfaces. */
export function installGlobalErrorHandlers(): void {
  window.addEventListener("unhandledrejection", (e) => {
    console.error("Unhandled rejection:", e.reason);
    toast("Something went wrong, check the console for details", { kind: "error" });
  });
  window.onerror = (message, source, lineno, colno, error) => {
    console.error("Uncaught error:", error ?? message, source, lineno, colno);
    toast("Something went wrong, check the console for details", { kind: "error" });
  };
}
