// The Stress panel's view: it reads and writes the store's setup, hands its
// buttons to the facade, and shows the result with its legend.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import StressPanel from "../../../src/components/overlays/StressPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { usePanelsStore } from "../../../src/stores/panels";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

function makeEngine() {
  const panels = {
    stressBodies: () => [{ id: "b1", name: "Bracket" }],
    setStressBody: vi.fn(),
    setStressFacesFromSelection: vi.fn(),
    addStressLoad: vi.fn(),
    removeStressLoad: vi.fn(),
    runStress: vi.fn(),
    cancelStress: vi.fn(),
    closeStress: vi.fn(),
    setStressColours: vi.fn(),
  };
  const store = { onBuild: (fn: () => void) => { fn(); return () => {}; } };
  return { engine: { store, ui: { panels } } as unknown as Engine, panels };
}

async function mounted() {
  const { engine, panels } = makeEngine();
  const w = mount(StressPanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  await flushPromises();
  return { w, panels };
}

const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;

describe("StressPanel", () => {
  it("renders nothing while closed", async () => {
    await mounted();
    expect(q(".stress-panel")).toBeNull();
  });

  it("shows the setup and hands the face buttons to the facade", async () => {
    const { panels } = await mounted();
    usePanelsStore().showStress("b1");
    await flushPromises();
    expect(q(".stress-panel")?.textContent).toContain("Fixed faces");
    expect((q(".stress-body") as HTMLSelectElement).value).toBe("b1");
    q(".stress-set-fixed")!.click();
    q(".stress-set-load")!.click();
    expect(panels.setStressFacesFromSelection.mock.calls).toEqual([["fixed"], [1]]);
    q(".stress-run")!.click();
    expect(panels.runStress).toHaveBeenCalledOnce();
    expect((q(".stress-cancel") as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for E, nu and yield only for a custom material, and reads a blank size as automatic", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    await flushPromises();
    expect(q(".stress-panel")?.textContent).toContain("yield 50 MPa");
    p.stress!.setup.material = "Custom";
    await flushPromises();
    expect(q(".stress-panel")?.textContent).toContain("Poisson's ratio");
    const size = q(".stress-size") as HTMLInputElement;
    size.value = "1.5";
    size.dispatchEvent(new Event("input"));
    expect(p.stress!.setup.size).toBe(1.5);
    size.value = "";
    size.dispatchEvent(new Event("input"));
    expect(p.stress!.setup.size).toBeNull();
  });

  it("keeps the body while a Run is out, sizes in mm, and toggles the colours", async () => {
    const { panels } = await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    await flushPromises();
    expect(q(".stress-colours")).toBeNull();
    expect(q(".stress-size")?.parentElement?.textContent).toContain("mm");
    p.stressStarted();
    await flushPromises();
    expect((q(".stress-body") as HTMLSelectElement).disabled).toBe(true);
    p.stressFinished({});
    p.setStressColours("shown");
    await flushPromises();
    expect(q(".stress-colours")?.textContent).toBe("Hide colours");
    q(".stress-colours")!.click();
    expect(panels.setStressColours).toHaveBeenCalledWith(false);
    p.setStressColours("hidden");
    await flushPromises();
    q(".stress-colours")!.click();
    expect(panels.setStressColours).toHaveBeenLastCalledWith(true);
  });

  it("shows the result rows, the legend's ends and the warnings", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    p.stressFinished({
      result: {
        rows: [{ k: "Safety factor", v: "0.8" }],
        warnings: ["printed parts are weaker across layers"],
        legend: { min: 0.5, max: 62 },
        yields: true,
      },
    });
    await flushPromises();
    const text = q(".stress-panel")!.textContent!;
    expect(text).toContain("0.5 MPa");
    expect(text).toContain("62 MPa");
    expect(text).toContain("printed parts are weaker across layers");
    expect(q(".stress-yields")?.textContent).toBe("0.8");
    expect(q(".stress-legend")?.getAttribute("style")).toContain("linear-gradient");
  });
});
