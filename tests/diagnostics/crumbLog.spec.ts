// Crumbs and sticky facts also go to the app's log through `log_line`, so they
// outlive the window. Outside the app there is no log to write to.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { breadcrumbs, crumb, stickyFact } from "../../src/diagnostics/breadcrumbs";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));

const inApp = (on: boolean) => {
  const w = window as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
};
const logged = () => invoke.mock.calls.map(([cmd, args]) => [cmd, (args as { line: string }).line]);

describe("crumbs in the app log", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });
  afterEach(() => inApp(false));

  it("writes nothing outside the app", async () => {
    crumb("[toast] Could not open bracket.funda");
    stickyFact("[gpu] WebGPU stand in: software adapter");
    await flushPromises();
    expect(invoke.mock.calls).toEqual([]);
  });

  it("writes one crumb with its time, and every sticky fact past the ones the report keeps", async () => {
    inApp(true);
    crumb("[toast] Exported bracket.step");
    await flushPromises();
    expect(logged()).toEqual([
      ["log_line", expect.stringMatching(/^\d\d:\d\d:\d\d \[toast\] Exported bracket\.step$/)],
    ]);

    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    const facts = Array.from({ length: 30 }, (_, i) => `[spacemouse] interface ${i} of 30`);
    facts.forEach(stickyFact);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(30));
    expect(logged()).toEqual(facts.map((f) => ["log_line", f]));
    // The report keeps 24 sticky facts, the first test's one among them.
    expect(breadcrumbs().slice(0, 25)).toEqual([
      "[gpu] WebGPU stand in: software adapter",
      ...facts.slice(0, 23),
      expect.stringMatching(/^\d\d:\d\d:\d\d \[toast\] Could not open/),
    ]);
  });

  it("keeps a crumb whose log write failed, without an unhandled rejection", async () => {
    inApp(true);
    invoke.mockRejectedValue(new Error("the app is closing"));
    const line = "x".repeat(400);
    crumb(line);
    await flushPromises();
    expect(logged()).toEqual([["log_line", expect.stringMatching(/^\d\d:\d\d:\d\d x{291}$/)]]);
    expect(breadcrumbs().at(-1)).toEqual(logged()[0]?.[1]);
  });
});
