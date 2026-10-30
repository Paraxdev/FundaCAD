// The Stress setup's support and load rows: each can be removed and cleared the same way.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import StressPanel from "../../../src/components/overlays/StressPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { usePanelsStore } from "../../../src/stores/panels";
import type { Selector } from "../../../src/types";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

function makeEngine() {
  const panels = {
    stressBodies: () => [{ id: "b1", name: "Bracket" }],
    setStressBody: vi.fn(),
    setStressFacesFromSelection: vi.fn(),
    addStressSupport: vi.fn(),
    removeStressSupport: vi.fn(),
    setStressSupportType: vi.fn(),
    addStressLoad: vi.fn(),
    removeStressLoad: vi.fn(),
    clearStressPlaces: vi.fn(),
    removeStressSpot: vi.fn(),
    placeStressSpot: vi.fn(),
    runStress: vi.fn(),
    cancelStress: vi.fn(),
    closeStress: vi.fn(),
  };
  const store = {
    onBuild: (fn: () => void) => {
      fn();
      return () => {};
    },
  };
  return { engine: { store, ui: { panels } } as unknown as Engine, panels };
}

async function mounted() {
  const { engine, panels } = makeEngine();
  mount(StressPanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  const p = usePanelsStore();
  p.showStress("b1");
  await flushPromises();
  return { panels, p };
}

const q = (sel: string) => document.body.querySelector(sel) as HTMLButtonElement | null;
const sel: Selector = { kind: "face", by: "nearest", point: [12.5, -3, 4.25], body: "b1" };
const faces = { selectors: [sel], faceIds: [4], normalSum: [0, 0, 1] as [number, number, number], area: 9 };

describe("StressSetupStep rows", () => {
  it("shows a support's remove button even when it is the only one, in the load's place and style", async () => {
    const { panels, p } = await mounted();
    expect(p.stress!.setup.supports).toHaveLength(1);
    const support = q(".stress-item-head .stress-remove-support");
    const load = q(".stress-item-head .stress-remove-load");
    expect(support, "the only support can be removed").not.toBeNull();
    const style = (b: HTMLElement) => [...b.classList].filter((c) => !c.startsWith("stress-")).sort();
    expect(style(support!)).toEqual(style(load!));
    expect(support!.title).toBe("Remove support 1");
    support!.click();
    expect(panels.removeStressSupport).toHaveBeenCalledWith(1);
  });

  it("offers Clear on a support and a load, off while the row holds nothing", async () => {
    const { panels, p } = await mounted();
    const clearSupport = q(".stress-faces .stress-clear-support")!;
    const clearLoad = q(".stress-faces .stress-clear-load")!;
    expect(clearSupport.textContent).toContain("Clear");
    expect(clearSupport.disabled || clearSupport.getAttribute("aria-disabled") === "true").toBe(true);
    expect(clearLoad.disabled || clearLoad.getAttribute("aria-disabled") === "true").toBe(true);

    p.setStressSupportFaces(1, faces);
    p.addStressSpot({ load: 1 }, { at: [0, 0, 5], radius: 3 });
    await flushPromises();
    expect(clearSupport.disabled).toBe(false);
    expect(clearSupport.getAttribute("aria-disabled")).not.toBe("true");
    expect(clearLoad.disabled, "a spot alone is something to clear").toBe(false);
    expect(clearSupport.title).toBe("Clear the faces and spots of support 1");
    expect(clearLoad.title).toBe("Clear the faces and spots of load 1");

    clearSupport.click();
    clearLoad.click();
    expect(panels.clearStressPlaces.mock.calls).toEqual([[{ support: 1 }], [{ load: 1 }]]);
  });
});
