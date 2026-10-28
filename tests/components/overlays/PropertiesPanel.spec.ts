// The Properties panel's view: a body that is not a sound solid shows why in
// place of the mass and filament estimate.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PropertiesPanel from "../../../src/components/overlays/PropertiesPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { usePanelsStore } from "../../../src/stores/panels";
import { printPrefs } from "../../../src/ui/printPrefs";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

const OPEN = "Casing is not a closed solid, 4 of its edges bound only one face, so it has no inside";

async function mounted() {
  const engine = { ui: { panels: { closeProperties: () => {} } } } as unknown as Engine;
  mount(PropertiesPanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  await flushPromises();
}

const text = () => document.body.querySelector(".properties-panel")?.textContent ?? "";

describe("PropertiesPanel", () => {
  it("shows the mass estimate of a sound body", async () => {
    await mounted();
    usePanelsStore().showProperties({
      title: "Casing",
      rows: [{ k: "Volume", v: "1000 mm³" }],
      raw: { volumeMm3: 1000, areaMm2: 600 },
      faults: [],
    });
    await flushPromises();
    expect(text()).toContain("Mass, estimate");
    expect(text()).not.toContain("not a sound solid");
  });

  it("says why a body has no volume or mass in place of the estimate", async () => {
    await mounted();
    usePanelsStore().showProperties({
      title: "Casing",
      rows: [{ k: "Surface area", v: "500 mm²" }],
      raw: null,
      faults: [OPEN],
    });
    await flushPromises();
    expect(text()).toContain("Not a sound solid, so no volume or mass");
    expect(text()).toContain(OPEN);
    expect(text()).not.toContain("Mass, estimate");
    expect(text()).not.toContain("Filament,");
  });

  it("takes a wall thickness in any length unit, estimates with it per keystroke and saves it as mm on change", async () => {
    await mounted();
    usePanelsStore().showProperties({
      title: "Casing",
      rows: [],
      raw: { volumeMm3: 1000, areaMm2: 600 },
      faults: [],
    });
    await flushPromises();
    const mass = () =>
      [...document.body.querySelectorAll(".properties-panel .measure-row")]
        .find((r) => r.textContent?.includes("Mass, estimate"))
        ?.querySelector(".measure-v")?.textContent;
    const saved = printPrefs().wallThicknessMm;
    const before = mass();
    const wall = document.body.querySelector<HTMLInputElement>('.properties-panel input[aria-label="Wall thickness"]')!;
    wall.value = "0.05 in";
    wall.dispatchEvent(new Event("input"));
    await flushPromises();
    expect([printPrefs().wallThicknessMm, mass() === before]).toEqual([saved, false]);
    wall.dispatchEvent(new Event("change"));
    expect(printPrefs().wallThicknessMm).toBeCloseTo(1.27, 9);
    expect(document.body.querySelector('.properties-panel input[type="number"]')).toBeNull();
  });
});
