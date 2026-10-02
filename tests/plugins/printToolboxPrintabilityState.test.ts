import { describe, expect, it } from "vitest";
import { createPrintabilityState } from "../../plugins/FundaCAD.PrintToolbox/printabilityState";
import type { PrintabilityView } from "../../plugins/FundaCAD.PrintToolbox/printability";

// The toolbox's Printability panel state: the settings survive reopening, a
// Check moves through started, sent, finished, and a new result starts with
// nothing put forward.

const view: PrintabilityView = { header: "+Z up", groups: [], findings: [], kinds: [], errors: [] };

describe("printability panel state", () => {
  it("opens with the default settings", () => {
    const p = createPrintabilityState();
    expect(p.data.value).toBeNull();
    p.show();
    expect(p.data.value?.setup).toMatchObject({ nozzle: 0.4, layer: 0.2, overhang: 45, minGap: 0.2, maxBridge: 10, up: "+Z", layFlat: false });
    expect(Object.values(p.data.value!.setup.checks).every(Boolean)).toBe(true);
    expect(p.data.value?.running).toBe(false);
  });

  it("keeps the settings when opened again, and drops them on close", () => {
    const p = createPrintabilityState();
    p.show();
    p.data.value!.setup.nozzle = 0.6;
    p.show();
    expect(p.data.value?.setup.nozzle).toBe(0.6);
    p.close();
    expect(p.data.value).toBeNull();
  });

  it("tracks a Check from start to result, and a cancel leaves the last result", () => {
    const p = createPrintabilityState();
    p.show();
    p.finished({ error: "tick at least one check" });
    expect(p.data.value?.error).toBe("tick at least one check");
    p.started();
    expect(p.data.value?.running).toBe(true);
    expect(p.data.value?.error).toBeNull();
    p.sent("req-1");
    expect(p.data.value?.requestId).toBe("req-1");
    p.finished({ result: view });
    expect(p.data.value?.running).toBe(false);
    expect(p.data.value?.requestId).toBeNull();
    expect(p.data.value?.result?.header).toBe("+Z up");
    p.started();
    p.finished({});
    expect(p.data.value?.result?.header).toBe("+Z up");
  });

  it("starts a new result fresh and marks an old one stale", () => {
    const p = createPrintabilityState();
    p.show();
    p.setStale();
    expect(p.data.value?.stale).toBe(false);
    p.finished({ result: view });
    p.setFocus("hovered", 2);
    p.setFocus("picked", 1);
    p.setStale();
    expect(p.data.value?.stale).toBe(true);
    p.finished({ result: view });
    expect(p.data.value).toMatchObject({ stale: false, hovered: null, picked: null });
  });

  it("ignores an id that arrives after the Check settled", () => {
    const p = createPrintabilityState();
    p.show();
    p.sent("late");
    expect(p.data.value?.requestId).toBeNull();
  });

  it("keeps one panel's state apart from another's", () => {
    // One per activation: switched off and on again, the panel starts fresh.
    const a = createPrintabilityState();
    const b = createPrintabilityState();
    a.show();
    expect(b.data.value).toBeNull();
  });
});
