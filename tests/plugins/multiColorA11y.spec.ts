// The filament palette for a screen reader: the sync button and every swatch are named, the slots are a list, the
// connection dot says what it shows, and a drifted machine is a warning in words. The native colour picker stays raw.

import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import PaletteSection from "../../plugins/FundaCAD.MultiColor/PaletteSection.vue";
import { FILAMENTS, type FilamentSlot } from "../../plugins/FundaCAD.MultiColor/palette";
import { ENGINE } from "../../src/app/engineKey";
import { contribute, resetContributions } from "../../src/plugins/contrib";
import type { Engine } from "../../src/app/engine";
import { nameOf, rawControls, unnamed } from "./pluginA11y";

enableAutoUnmount(afterEach);

afterEach(() => {
  resetContributions();
  vi.useRealTimers();
});

function fakeEngine() {
  const store = {
    document: { parameters: {}, features: [] },
    buildState: { building: false, errorFeatureId: null, result: { bodies: [{ id: "b1" }] } },
    colorPalette: [
      { name: "Polymaker PLA", color: "#d23b30", material: "PLA" },
      { name: "Toolhead 2", color: "#e8e8e8" },
    ],
    setPaletteSlot: vi.fn(),
  };
  return {
    store,
    engine: {
      store,
      bridge: { docVersion: ref(0), buildVersion: ref(0), metaVersion: ref(0) },
    } as unknown as Engine,
  };
}

const slot = (over: Partial<FilamentSlot> = {}): FilamentSlot => ({
  index: 0,
  present: true,
  vendor: "Polymaker",
  material: "PLA",
  color: "#d23b30",
  ...over,
});

function machine(read: () => Promise<FilamentSlot[]> = () => Promise.resolve([slot()])) {
  contribute("Some.Printer", {
    provides: {
      [FILAMENTS]: { probe: () => Promise.resolve(true), read, sync: () => Promise.resolve(true) },
    },
  });
}

async function open() {
  setActivePinia(createPinia());
  const fake = fakeEngine();
  const w = mount(PaletteSection, {
    attachTo: document.body,
    global: { provide: { [ENGINE as symbol]: fake.engine } },
  });
  for (let i = 0; i < 20 && !w.find(".pal-dot").exists(); i++) await nextTick();
  return { w, root: w.element.parentElement as HTMLElement, fake };
}

describe("the filament palette, for a screen reader", () => {
  it("names every control and keeps only the native colour picker raw", async () => {
    machine();
    const { root } = await open();
    expect(unnamed(root)).toEqual([]);
    expect(rawControls(root)).toEqual(["input[color]", "input[color]"]);
    expect(nameOf(root.querySelector(".pal-sync")!)).toBe("Sync filaments from printer");
    expect([...root.querySelectorAll(".pal-swatch")].map(nameOf)).toEqual([
      "Colour of Polymaker PLA",
      "Colour of Toolhead 2",
    ]);
  });

  it("draws the slots as a named list with the material in each item", async () => {
    machine();
    const { root } = await open();
    const list = root.querySelector("[role=list]")!;
    expect(nameOf(list)).toBe("Filament slots");
    const items = [...list.querySelectorAll("[role=listitem]")];
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("PLA");
    expect(items[0]!.querySelector(".pal-swatch")).not.toBeNull();
  });

  it("gives the connection dot a name that says the state", async () => {
    machine();
    const { root } = await open();
    const dot = root.querySelector(".pal-dot")!;
    expect(dot.getAttribute("role")).toBe("img");
    expect(nameOf(dot)).toBe("Printer connection");
  });

  it("says in words, as an alert, that the machine drifted from the palette", async () => {
    vi.useFakeTimers();
    machine(() => Promise.resolve([slot({ color: "#00ff00" })]));
    setActivePinia(createPinia());
    const fake = fakeEngine();
    mount(PaletteSection, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: fake.engine } } });
    await vi.advanceTimersByTimeAsync(31_000);
    await nextTick();
    const alert = document.body.querySelector("[role=alert]")!;
    expect(alert.textContent).toMatch(/^Warning: .*changed since sync/);
    expect(document.body.querySelector(".pal-dot")!.getAttribute("aria-label")).toMatch(/changed since sync/);
  });

  it("shows no alert while the machine matches", async () => {
    machine();
    const { root } = await open();
    expect(root.querySelector("[role=alert]")).toBeNull();
  });
});
