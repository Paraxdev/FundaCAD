// The Printability panel's view: it binds the store's settings, hands its
// buttons and rows to the facade, and shows the findings by body with a legend.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PrintabilityPanel from "../../../src/components/overlays/PrintabilityPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { usePanelsStore } from "../../../src/stores/panels";
import { useBrowserStore } from "../../../src/stores/browser";
import { formatPrintabilityResult } from "../../../src/ui/printability";
import type { PrintabilityReply } from "../../../src/geometry/client";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

function makeEngine() {
  const panels = {
    printabilityBodies: () => [{ id: "body1", name: "Bracket" }, { id: "body2", name: "Lid" }],
    runPrintability: vi.fn(),
    cancelPrintability: vi.fn(),
    closePrintability: vi.fn(),
    hoverFinding: vi.fn(),
    pickFinding: vi.fn(),
  };
  const store = { onBuild: (fn: () => void) => { fn(); return () => {}; } };
  return { engine: { store, ui: { panels } } as unknown as Engine, panels };
}

async function mounted() {
  const { engine, panels } = makeEngine();
  const w = mount(PrintabilityPanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  await flushPromises();
  return { w, panels };
}

const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.body.querySelectorAll(sel)] as HTMLElement[];

const reply: PrintabilityReply = {
  header: "+Z up as modelled, bed at z = 0",
  report: "",
  settings: { nozzle: 0.4, layer: 0.2, overhang: 45, minGap: 0.2, maxBridge: 10, up: "+Z", layFlat: false },
  bodies: [
    { id: "body1", name: "Bracket", up: [0, 0, 1], bed: 0, bedFace: 1, openEdges: 0, solids: 1, insideOut: false },
    { id: "body2", name: "Lid", up: [0, 0, 1], bed: 0, bedFace: 1, openEdges: 4, solids: 1, insideOut: false },
    { id: "body3", name: "Pin", up: [0, 0, 1], bed: 0, bedFace: 1, openEdges: 0, solids: 1, insideOut: false },
  ],
  findings: [
    { kind: "overhang", body: "body1", face: 3, other: null, value: 90, limit: 0, area: 132, low: 5, at: [0, 0, 5], extent: 6, note: "" },
    { kind: "bridge", body: "body1", face: 4, other: null, value: 14, limit: 10, area: 40, low: 0, at: [0, 0, 8], extent: 14, note: "" },
  ],
  errors: [{ feature_id: "f3", message: "fillet failed" }],
};

describe("PrintabilityPanel", () => {
  it("renders nothing while closed", async () => {
    await mounted();
    expect(q(".printability-panel")).toBeNull();
  });

  it("shows the defaults, binds the settings and hands Check to the facade", async () => {
    const { panels } = await mounted();
    const p = usePanelsStore();
    p.showPrintability();
    await flushPromises();
    expect((q(".printability-nozzle") as HTMLInputElement).value).toBe("0.4");
    expect((q(".printability-layer") as HTMLInputElement).value).toBe("0.2");
    expect((q(".printability-overhang") as HTMLInputElement).value).toBe("45");
    expect((q(".printability-gap") as HTMLInputElement).value).toBe("0.2");
    expect((q(".printability-bridge") as HTMLInputElement).value).toBe("10");
    expect((q(".printability-up") as HTMLSelectElement).value).toBe("+Z");
    const nozzle = q(".printability-nozzle") as HTMLInputElement;
    nozzle.value = "0.6";
    nozzle.dispatchEvent(new Event("input"));
    expect(p.printability!.setup.nozzle).toBe(0.6);
    (q(".printability-check-wall") as HTMLInputElement).click();
    expect(p.printability!.setup.checks.wall).toBe(false);
    q(".printability-run")!.click();
    expect(panels.runPrintability).toHaveBeenCalledOnce();
    expect((q(".printability-cancel") as HTMLButtonElement).disabled).toBe(true);
  });

  it("turns off the up choice while laying flat", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showPrintability();
    await flushPromises();
    (q(".printability-layflat") as HTMLInputElement).click();
    await flushPromises();
    expect(p.printability!.setup.layFlat).toBe(true);
    expect((q(".printability-up") as HTMLSelectElement).disabled).toBe(true);
  });

  it("says which bodies a Check covers", async () => {
    await mounted();
    usePanelsStore().showPrintability();
    await flushPromises();
    expect(q(".printability-scope")?.textContent).toBe("All 2");
    useBrowserStore().setSelectedBodies(["body2"]);
    await flushPromises();
    expect(q(".printability-scope")?.textContent).toBe("Lid");
  });

  it("enables Cancel while a Check runs", async () => {
    const { panels } = await mounted();
    const p = usePanelsStore();
    p.showPrintability();
    p.printabilityStarted();
    await flushPromises();
    expect(q(".printability-run")?.textContent).toBe("Checking…");
    q(".printability-cancel")!.click();
    expect(panels.cancelPrintability).toHaveBeenCalledOnce();
  });

  it("lists the findings by body, with body notes, Nothing found, the legend and the failures", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showPrintability();
    p.printabilityFinished({ result: formatPrintabilityResult(reply) });
    await flushPromises();
    expect(q(".printability-header")?.textContent).toBe("+Z up as modelled, bed at z = 0");
    expect(qa(".printability-body").map((e) => e.textContent)).toEqual(["Bracket", "Lid", "Pin"]);
    expect(qa(".printability-finding").map((e) => e.textContent)).toEqual([
      "Overhang, 132 mm² leaning 90°",
      "Bridge 14 mm span (over 10)",
    ]);
    expect(q(".printability-note")?.textContent).toBe("Open shell, 4 open edges");
    expect(qa(".printability-clean")).toHaveLength(1);
    expect(qa(".printability-legend-item").map((e) => e.textContent)).toEqual(["Overhang", "Bridge"]);
    expect(q(".printability-warning")?.textContent).toBe("f3: fillet failed");
    expect(q(".printability-panel")!.textContent).not.toMatch(/ - |\u2014/);
  });

  it("hands a row's hover and click to the facade and marks the focused row", async () => {
    const { panels } = await mounted();
    const p = usePanelsStore();
    p.showPrintability();
    p.printabilityFinished({ result: formatPrintabilityResult(reply) });
    await flushPromises();
    const row = qa(".printability-finding")[1]!;
    row.dispatchEvent(new MouseEvent("mouseenter"));
    row.click();
    row.dispatchEvent(new MouseEvent("mouseleave"));
    expect(panels.hoverFinding.mock.calls).toEqual([[1], [null]]);
    expect(panels.pickFinding).toHaveBeenCalledWith(1);
    p.setPrintabilityFocus("picked", 1);
    await flushPromises();
    expect(qa(".printability-finding").map((e) => e.classList.contains("is-focus"))).toEqual([false, true]);
  });

  it("shows a refusal and a stale result's hint", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showPrintability();
    p.printabilityFinished({ error: "face 7 of body1 is not flat" });
    await flushPromises();
    expect(q(".printability-error")?.textContent).toBe("face 7 of body1 is not flat");
    p.printabilityFinished({ result: formatPrintabilityResult({ ...reply, bodies: [], findings: [], errors: [] }) });
    p.setPrintabilityStale();
    await flushPromises();
    expect(q(".printability-clean")?.textContent).toBe("Nothing found");
    expect(q(".printability-stale")).not.toBeNull();
  });

  it("closes through the facade", async () => {
    const { panels } = await mounted();
    usePanelsStore().showPrintability();
    await flushPromises();
    q(".printability-close")!.click();
    expect(panels.closePrintability).toHaveBeenCalledOnce();
  });
});
