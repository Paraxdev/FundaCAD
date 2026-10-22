// The global rejection nets stay quiet for work of a closed document and still report every other failure.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionEnded } from "../../src/document/session";

const toasts: string[] = [];
vi.mock("../../src/ui/toast", () => ({ toast: (m: string) => toasts.push(m) }));

class RejectionEvent extends Event {
  constructor(readonly reason: unknown) {
    super("unhandledrejection");
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("rejection nets and SessionEnded", () => {
  it("a SessionEnded reaches no net, any other rejection still reaches both", async () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("navigator", { userAgent: "test" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { installGlobalErrorHandlers } = await import("../../src/app/errors");
    const { breadcrumbs } = await import("../../src/diagnostics/breadcrumbs");
    installGlobalErrorHandlers();
    const before = breadcrumbs().length;
    window.dispatchEvent(new RejectionEvent(new SessionEnded()));
    const quiet = { toasts: [...toasts], crumbs: breadcrumbs().length - before, logged: err.mock.calls.length };
    window.dispatchEvent(new RejectionEvent(new Error("engine fell over")));
    const loud = {
      toasts: [...toasts],
      crumbs: breadcrumbs()
        .slice(before)
        .map((c) => c.replace(/^\S+ /, "")),
      logged: err.mock.calls.length,
    };
    err.mockRestore();
    expect({ quiet, loud }).toEqual({
      quiet: { toasts: [], crumbs: 0, logged: 0 },
      loud: {
        toasts: ["Unexpected error: engine fell over"],
        crumbs: ["[unhandledrejection] engine fell over"],
        logged: 1,
      },
    });
  });
});
