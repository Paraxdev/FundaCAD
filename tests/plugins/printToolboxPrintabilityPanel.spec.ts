// The toolbox's Printability panel view: it binds the controller's settings,
// hands its buttons and rows to the controller, and shows the findings by body
// with a legend.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { shallowRef } from "vue";
import PrintabilityPanel from "../../plugins/FundaCAD.PrintToolbox/PrintabilityPanel.vue";
import { printabilityPanel, type PrintabilityPanel as Controller } from "../../plugins/FundaCAD.PrintToolbox/printabilityPanel";
import { createPrintabilityState } from "../../plugins/FundaCAD.PrintToolbox/printabilityState";
import { formatPrintabilityResult } from "../../plugins/FundaCAD.PrintToolbox/printability";
import { useBrowserStore } from "../../src/stores/browser";
import type { PrintabilityReply } from "fundacad";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => { printabilityPanel.value = null; });

/** The real state, with the controller's actions as spies. */
function makeController() {
  const state = createPrintabilityState();
  const ctl = {
    state,
    data: state.data,
    bodies: shallowRef([{ id: "body1", name: "Bracket" }, { id: "body2", name: "Lid" }]),
    run: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
    hover: vi.fn(),
    pick: vi.fn(),
  };
  printabilityPanel.value = ctl as unknown as Controller;
  return ctl;
}

async function mounted() {
  const ctl = makeController();
  const w = mount(PrintabilityPanel, { attachTo: document.body });
  await flushPromises();
  return { w, ctl, p: ctl.state };
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

  it("renders nothing with the plugin switched off", async () => {
    const { p } = await mounted();
    p.show();
    printabilityPanel.value = null;
    await flushPromises();
    expect(q(".printability-panel")).toBeNull();
  });

  it("shows the defaults, binds the settings and hands Check to the controller", async () => {
    const { ctl, p } = await mounted();
    p.show();
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
    expect(p.data.value!.setup.nozzle).toBe(0.6);
    (q(".printability-check-wall") as HTMLInputElement).click();
    expect(p.data.value!.setup.checks.wall).toBe(false);
    q(".printability-run")!.click();
    expect(ctl.run).toHaveBeenCalledOnce();
    expect((q(".printability-cancel") as HTMLButtonElement).disabled).toBe(true);
  });

  it("turns off the up choice while laying flat", async () => {
    const { p } = await mounted();
    p.show();
    await flushPromises();
    (q(".printability-layflat") as HTMLInputElement).click();
    await flushPromises();
    expect(p.data.value!.setup.layFlat).toBe(true);
    expect((q(".printability-up") as HTMLSelectElement).disabled).toBe(true);
  });

  it("says which bodies a Check covers", async () => {
    const { p } = await mounted();
    p.show();
    await flushPromises();
    expect(q(".printability-scope")?.textContent).toBe("All 2");
    useBrowserStore().setSelectedBodies(["body2"]);
    await flushPromises();
    expect(q(".printability-scope")?.textContent).toBe("Lid");
  });

  it("enables Cancel while a Check runs", async () => {
    const { ctl, p } = await mounted();
    p.show();
    p.started();
    await flushPromises();
    expect(q(".printability-run")?.textContent).toBe("Checking…");
    q(".printability-cancel")!.click();
    expect(ctl.cancel).toHaveBeenCalledOnce();
  });

  it("lists the findings by body, with body notes, Nothing found, the legend and the failures", async () => {
    const { p } = await mounted();
    p.show();
    p.finished({ result: formatPrintabilityResult(reply) });
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

  it("hands a row's hover and click to the controller and marks the focused row", async () => {
    const { ctl, p } = await mounted();
    p.show();
    p.finished({ result: formatPrintabilityResult(reply) });
    await flushPromises();
    const row = qa(".printability-finding")[1]!;
    row.dispatchEvent(new MouseEvent("mouseenter"));
    row.click();
    row.dispatchEvent(new MouseEvent("mouseleave"));
    expect(ctl.hover.mock.calls).toEqual([[1], [null]]);
    expect(ctl.pick).toHaveBeenCalledWith(1);
    p.setFocus("picked", 1);
    await flushPromises();
    expect(qa(".printability-finding").map((e) => e.classList.contains("is-focus"))).toEqual([false, true]);
  });

  it("shows a refusal and a stale result's hint", async () => {
    const { p } = await mounted();
    p.show();
    p.finished({ error: "face 7 of body1 is not flat" });
    await flushPromises();
    expect(q(".printability-error")?.textContent).toBe("face 7 of body1 is not flat");
    p.finished({ result: formatPrintabilityResult({ ...reply, bodies: [], findings: [], errors: [] }) });
    p.setStale();
    await flushPromises();
    expect(q(".printability-clean")?.textContent).toBe("Nothing found");
    expect(q(".printability-stale")).not.toBeNull();
  });

  it("closes through the controller", async () => {
    const { ctl, p } = await mounted();
    p.show();
    await flushPromises();
    q(".printability-close")!.click();
    expect(ctl.close).toHaveBeenCalledOnce();
  });
});
