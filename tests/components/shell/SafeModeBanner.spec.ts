import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const invoke = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import SafeModeBanner from "../../../src/components/shell/SafeModeBanner.vue";
import { slotFor } from "../../../src/io/recovery";
import { useDialogStore } from "../../../src/stores/dialogs";
import type { BugReportDeps } from "../../../src/ui/bugReporter";

enableAutoUnmount(afterEach);
afterEach(() => {
  delete window.__FUNDACAD_SAFE_MODE__;
  invoke.mockClear();
});

describe("the safe mode banner", () => {
  it("is not there on a normal start", () => {
    const w = mount(SafeModeBanner);
    expect(w.find("#safe-mode-banner").exists()).toBe(false);
  });

  it("says the app started in safe mode, why, and what is off", () => {
    window.__FUNDACAD_SAFE_MODE__ = { reason: "failedStarts", failedStarts: 2 };
    const w = mount(SafeModeBanner);
    const text = w.get("#safe-mode-banner").text();
    expect(text).toContain("FundaCAD started in safe mode");
    expect(text).toContain("the last 2 starts did not finish");
    expect(text).toContain("Plugins, saved preferences and work recovery are off");
    expect(w.get("button").text()).toBe("Restart normally");
  });

  it("names the switch and how to take it out when one forced it", () => {
    window.__FUNDACAD_SAFE_MODE__ = { reason: "flag", failedStarts: 0 };
    expect(mount(SafeModeBanner).text()).toMatch(/started with --safe-mode.*take the switch out/s);
    window.__FUNDACAD_SAFE_MODE__ = { reason: "env", failedStarts: 0 };
    expect(mount(SafeModeBanner).text()).toMatch(/FUNDACAD_SAFE_MODE is set.*Remove FUNDACAD_SAFE_MODE/s);
  });

  it("restarts normally from its button, once", async () => {
    window.__FUNDACAD_SAFE_MODE__ = { reason: "failedStarts", failedStarts: 3 };
    const w = mount(SafeModeBanner);
    await w.get("button").trigger("click");
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("safe_mode_exit");
    expect(w.get("button").attributes("disabled")).toBeDefined();
  });

  it("says so and lets the button be pressed again when the restart fails", async () => {
    window.__FUNDACAD_SAFE_MODE__ = { reason: "failedStarts", failedStarts: 2 };
    invoke.mockRejectedValueOnce("no executable");
    const w = mount(SafeModeBanner);
    await w.get("button").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("Could not restart: no executable");
    expect(w.get("button").attributes("disabled")).toBeUndefined();
  });

  it("opens the problem report from its second button", async () => {
    setActivePinia(createPinia());
    window.__FUNDACAD_SAFE_MODE__ = { reason: "failedStarts", failedStarts: 3 };
    useDialogStore().bindBugReporter({} as BugReportDeps);
    const w = mount(SafeModeBanner);
    expect(w.findAll("button").map((b) => b.text())).toEqual(["Restart normally", "Report a problem"]);
    await w.get(".safe-report").trigger("click");
    expect([useDialogStore().bugReport, invoke.mock.calls]).toEqual([true, []]);
  });

  it("keeps its recovery snapshots apart from the ones it did not offer", () => {
    expect(slotFor(null)).toBe("untitled");
    window.__FUNDACAD_SAFE_MODE__ = { reason: "flag", failedStarts: 0 };
    expect(slotFor(null)).toBe("safe-untitled");
    expect(slotFor("C:/a/part.funda")).toMatch(/^safe-part_/);
  });
});
