// A resize notice with no Error object reaches no toast, log or crumb, and a real window error still does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isBrowserNotice } from "../../src/diagnostics/browserNotice";

const toasts: string[] = [];
vi.mock("../../src/ui/toast", () => ({ toast: (m: string) => toasts.push(m) }));

const NOTICE = "ResizeObserver loop completed with undelivered notifications.";

class WindowError extends Event {
  constructor(readonly message: string) {
    super("error");
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("window errors and the resize notice", () => {
  it("knows the notice in both browsers' wording and nothing else", () => {
    expect(isBrowserNotice(NOTICE, undefined)).toBe(true);
    expect(isBrowserNotice("ResizeObserver loop limit exceeded", null)).toBe(true);
    expect(isBrowserNotice("TypeError: x is undefined", undefined)).toBe(false);
    expect(isBrowserNotice(new Event("error"), undefined)).toBe(false);
  });

  it("a thrown Error with the same text is a real error", () => {
    expect(isBrowserNotice(NOTICE, new Error(NOTICE))).toBe(false);
  });

  it("a notice reaches no toast or crumb, a real error reaches both", async () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("navigator", { userAgent: "test" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { installGlobalErrorHandlers } = await import("../../src/app/errors");
    const { breadcrumbs } = await import("../../src/diagnostics/breadcrumbs");
    installGlobalErrorHandlers();
    const before = breadcrumbs().length;
    const fire = (message: string) => {
      window.onerror?.(message, "tauri://localhost", 0, 0);
      window.dispatchEvent(new WindowError(message));
    };
    fire(NOTICE);
    const quiet = { toasts: [...toasts], crumbs: breadcrumbs().length - before, logged: err.mock.calls.length };
    fire("engine fell over");
    window.onerror?.(NOTICE, "plugin.js", 1, 1, new Error(NOTICE));
    const loud = { toasts: toasts.length, crumbs: breadcrumbs().length - before, logged: err.mock.calls.length };
    err.mockRestore();
    expect({ quiet, loud }).toEqual({
      quiet: { toasts: [], crumbs: 0, logged: 0 },
      loud: { toasts: 2, crumbs: 1, logged: 2 },
    });
  });
});
