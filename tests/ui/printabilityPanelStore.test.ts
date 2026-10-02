import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { usePanelsStore } from "../../src/stores/panels";
import type { PrintabilityView } from "../../src/ui/printability";

// The Printability panel's state: the settings survive reopening, a Check
// moves through started, sent, finished, and a new result starts with nothing
// put forward.

beforeEach(() => setActivePinia(createPinia()));

const view: PrintabilityView = { header: "+Z up", groups: [], findings: [], kinds: [], errors: [] };

describe("printability panel store", () => {
  it("opens with the default settings", () => {
    const p = usePanelsStore();
    expect(p.printability).toBeNull();
    p.showPrintability();
    expect(p.printability?.setup).toMatchObject({ nozzle: 0.4, layer: 0.2, overhang: 45, minGap: 0.2, maxBridge: 10, up: "+Z", layFlat: false });
    expect(Object.values(p.printability!.setup.checks).every(Boolean)).toBe(true);
    expect(p.printability?.running).toBe(false);
  });

  it("keeps the settings when opened again", () => {
    const p = usePanelsStore();
    p.showPrintability();
    p.printability!.setup.nozzle = 0.6;
    p.showPrintability();
    expect(p.printability?.setup.nozzle).toBe(0.6);
  });

  it("tracks a Check from start to result, and a cancel leaves the last result", () => {
    const p = usePanelsStore();
    p.showPrintability();
    p.printabilityFinished({ error: "tick at least one check" });
    expect(p.printability?.error).toBe("tick at least one check");
    p.printabilityStarted();
    expect(p.printability?.running).toBe(true);
    expect(p.printability?.error).toBeNull();
    p.printabilitySent("req-1");
    expect(p.printability?.requestId).toBe("req-1");
    p.printabilityFinished({ result: view });
    expect(p.printability?.running).toBe(false);
    expect(p.printability?.requestId).toBeNull();
    expect(p.printability?.result?.header).toBe("+Z up");
    p.printabilityStarted();
    p.printabilityFinished({});
    expect(p.printability?.result?.header).toBe("+Z up");
  });

  it("starts a new result fresh and marks an old one stale", () => {
    const p = usePanelsStore();
    p.showPrintability();
    p.setPrintabilityStale();
    expect(p.printability?.stale).toBe(false);
    p.printabilityFinished({ result: view });
    p.setPrintabilityFocus("hovered", 2);
    p.setPrintabilityFocus("picked", 1);
    p.setPrintabilityStale();
    expect(p.printability?.stale).toBe(true);
    p.printabilityFinished({ result: view });
    expect(p.printability).toMatchObject({ stale: false, hovered: null, picked: null });
  });

  it("ignores an id that arrives after the Check settled", () => {
    const p = usePanelsStore();
    p.showPrintability();
    p.printabilitySent("late");
    expect(p.printability?.requestId).toBeNull();
  });
});
