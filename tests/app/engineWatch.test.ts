import { describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

type Notice = { message: string; opts: { kind?: string; action?: { label: string; onClick: () => void } } };
const h = vi.hoisted(() => ({ died: null as ((e: { payload: unknown }) => void) | null, notices: [] as Notice[] }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, fn: (e: { payload: unknown }) => void) => {
    h.died = fn;
    return () => {};
  },
}));
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string, opts: Notice["opts"]) => void h.notices.push({ message, opts }),
}));

import { deathMessage, installEngineDiedToast } from "../../src/app/engineWatch";
import { useDialogStore } from "../../src/stores/dialogs";
import type { BugReportDeps } from "../../src/ui/bugReporter";

describe("what a dead geometry engine is called", () => {
  it("says the engine was restarted when the supervisor restarted it", () => {
    expect(deathMessage({ kind: "restarted", cause: "exit code 3" })).toBe(
      "The geometry engine crashed (exit code 3) and was restarted. The last operation did not finish.",
    );
  });

  it("says it could not start, not that it crashed, when the worker never ran", () => {
    expect(deathMessage({ kind: "start_failed", cause: "access denied" })).toContain("could not start");
  });

  it("never calls it the sidecar", () => {
    for (const kind of ["restarted", "start_failed", "exited"]) {
      expect(deathMessage({ kind, cause: "x" }).toLowerCase()).not.toContain("sidecar");
    }
    expect(deathMessage({ cause: "x" }).toLowerCase()).not.toContain("sidecar");
    expect(deathMessage(null)).toBe("The geometry engine crashed. Save your work, then restart FundaCAD.");
  });
});

describe("the engine stopped notice", () => {
  it("offers Report, which opens the problem report", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    installEngineDiedToast();
    await Promise.resolve();
    h.died!({ payload: { kind: "restarted", cause: "exit code 3", detail: "stack" } });
    expect(h.notices.map((n) => [n.opts.kind, n.opts.action?.label])).toEqual([["error", "Report"]]);

    useDialogStore().bindBugReporter({} as BugReportDeps);
    h.notices[0]!.opts.action!.onClick();
    expect(useDialogStore().bugReport).toBe(true);
    vi.unstubAllGlobals();
  });
});
