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
import { setLanguage } from "../../../src/i18n";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => setLanguage("system"));

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

  it("lists the measured rows as a dl of term and value pairs", async () => {
    await mounted();
    usePanelsStore().showProperties({
      title: "Casing",
      rows: [
        { k: "Volume", v: "1250.5 mm³" },
        { k: "Surface area", v: "612.25 mm²" },
      ],
      raw: null,
      faults: [],
    });
    await flushPromises();
    const pairs = [...document.body.querySelectorAll(".properties-panel dl > .measure-row")].map((r) => [
      r.querySelector("dt")?.textContent,
      r.querySelector("dd")?.textContent,
    ]);
    expect(pairs).toEqual([
      ["Volume", "1250.5 mm³"],
      ["Surface area", "612.25 mm²"],
    ]);
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

  it("shows the mass and the filament length with the language's decimal mark, and follows a language change", async () => {
    await mounted();
    usePanelsStore().showProperties({
      title: "Casing",
      rows: [],
      raw: { volumeMm3: 1234.5, areaMm2: 777.25 },
      faults: [],
    });
    await flushPromises();
    const estimates = () =>
      [...document.body.querySelectorAll(".properties-panel .measure-v")]
        .map((v) => v.textContent ?? "")
        .filter((v) => / [gm]$/.test(v));
    const english = estimates();
    expect(english.length).toBeGreaterThan(1);
    expect(english.every((v) => /^[0-9]+[.][0-9]+ [gm]$/.test(v))).toBe(true);
    await setLanguage("de");
    await flushPromises();
    expect(estimates()).toEqual(english.map((v) => v.replace(".", ",")));
    await setLanguage("system");
    await flushPromises();
    expect(estimates()).toEqual(english);
  });

  it("shows material densities and filament sizes with the language's mark", async () => {
    await mounted();
    usePanelsStore().showProperties({
      title: "Casing",
      rows: [{ k: "Volume", v: "1000 mm³" }],
      raw: { volumeMm3: 1000, areaMm2: 600 },
      faults: [],
    });
    await flushPromises();
    const decimals = () =>
      [...text().matchAll(/\((\d+[.,]\d+) g\/cm³\)|Filament, (\d+[.,]\d+)mm/g)].map((m) => m[1] ?? m[2] ?? "");
    const english = decimals();
    expect(english.length).toBeGreaterThan(1);
    expect(english.every((v) => v.includes("."))).toBe(true);
    await setLanguage("de");
    await flushPromises();
    expect(decimals()).toEqual(english.map((v) => v.replace(".", ",")));
  });
});
