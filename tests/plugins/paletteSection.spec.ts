// The filament palette, now that it is a plugin's panel rather than part of the
// browser.
//
// These cases were in tests/components/shell/BrowserPane.spec.ts, where they had
// to reach through the whole panel — mount the tree, stub a printer client by
// module path, flip a capability switch, then look for a dot. The panel is not
// what any of them were about. Mounted directly, each one is a sentence about
// the palette: it needs bodies, it needs something that can answer about
// filament, and it says which of the two is missing by drawing nothing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import PaletteSection from "../../plugins/FundaCAD.MultiColor/PaletteSection.vue";
import { FILAMENTS, type FilamentSlot } from "../../plugins/FundaCAD.MultiColor/palette";
import { ENGINE } from "../../src/app/engineKey";
import { contribute, resetContributions } from "../../src/plugins/contrib";
import type { Engine } from "../../src/app/engine";

afterEach(() => {
  resetContributions();
  vi.useRealTimers();
});

/** The narrowest engine this panel touches: a palette, and whether a build
 *  produced any bodies. */
function fakeEngine(bodies: { id: string }[]) {
  const docVersion = ref(0);
  const buildVersion = ref(0);
  const palette = [
    { name: "Polymaker PLA", color: "#d23b30", material: "PLA" },
    { name: "Toolhead 2", color: "#e8e8e8" },
  ];
  const store = {
    document: { parameters: {}, features: [] },
    buildState: { building: false, errorFeatureId: null, result: { bodies } },
    colorPalette: palette,
    setPaletteSlot: vi.fn(),
  };
  return {
    store,
    engine: { store, bridge: { docVersion, buildVersion, metaVersion: ref(0) } } as unknown as Engine,
  };
}

const slot = (over: Partial<FilamentSlot> = {}): FilamentSlot => ({
  index: 0, present: true, vendor: "Polymaker", material: "PLA", color: "#d23b30", ...over,
});

/** A stand-in for whatever can talk to a machine. */
function filaments(over: Partial<{ probe: () => Promise<boolean>; read: () => Promise<FilamentSlot[]>; sync: () => Promise<boolean> }> = {}) {
  return {
    probe: () => Promise.resolve(true),
    read: () => Promise.resolve([slot()]),
    sync: () => Promise.resolve(true),
    ...over,
  };
}

async function render(bodies: { id: string }[]) {
  setActivePinia(createPinia());
  const fake = fakeEngine(bodies);
  const w = mount(PaletteSection, {
    global: { provide: { [ENGINE as symbol]: fake.engine } },
  });
  // The probe is an awaited call behind a watcher, so it settles over several
  // microtasks; nextTick drains one each time round.
  for (let i = 0; i < 20 && !w.find(".pal-dot").exists(); i++) await nextTick();
  return { w, fake };
}

describe("the filament palette", () => {
  it("draws a slot per palette entry once a machine has answered", async () => {
    contribute("Some.Printer", { provides: { [FILAMENTS]: filaments() } });
    const { w } = await render([{ id: "b1" }]);
    expect(w.find(".pal-dot").exists()).toBe(true);
    expect(w.findAll(".pal-swatch")).toHaveLength(2);
    expect(w.text()).toContain("Polymaker PLA");
    // The material rides along, because "PLA" is what makes a slot mean a
    // physical filament rather than a colour.
    expect(w.find(".pal-material").text()).toBe("PLA");
  });

  it("draws nothing at all when nothing can answer about filament", async () => {
    // Not a hidden panel, an absent one. Every slot means "the material loaded
    // in toolhead N", and the sync button and the staleness dot only mean
    // anything against a machine that replies. With nobody on the other end it
    // was four fixed rows of nothing pinned above the bodies.
    //
    // This is also how the capability that owns printers being SWITCHED OFF
    // reaches here: it stops offering the service, and there is no second check
    // anywhere that names it.
    const { w } = await render([{ id: "b1" }]);
    expect(w.find(".pal-dot").exists()).toBe(false);
    expect(w.findAll(".pal-swatch")).toHaveLength(0);
  });

  it("draws nothing when the machine answers but says it is not there", async () => {
    // The control for the case above: an absent provider and an offline machine
    // are different situations, and if only the first were handled the dot would
    // sit permanently grey over a palette nobody can sync.
    contribute("Some.Printer", {
      provides: { [FILAMENTS]: filaments({ probe: () => Promise.resolve(false) }) },
    });
    const { w } = await render([{ id: "b1" }]);
    expect(w.find(".pal-dot").exists()).toBe(false);
  });

  it("waits for a body before asking anything at all", async () => {
    // The probe reaches the network. On an empty document there is nothing to
    // colour, so asking would be a LAN request on behalf of a panel that has
    // nothing to show.
    let probes = 0;
    contribute("Some.Printer", {
      provides: {
        [FILAMENTS]: filaments({ probe: () => { probes++; return Promise.resolve(true); } }),
      },
    });
    const { w } = await render([]);
    expect(probes).toBe(0);
    expect(w.find(".pal-dot").exists()).toBe(false);
  });

  it("asks the machine to sync when the button is pressed", async () => {
    const sync = vi.fn(() => Promise.resolve(true));
    contribute("Some.Printer", { provides: { [FILAMENTS]: filaments({ sync }) } });
    const { w, fake } = await render([{ id: "b1" }]);
    await w.get(".pal-sync").trigger("click");
    expect(sync).toHaveBeenCalledTimes(1);
    // ...and it is the store that gets written, by the printer, not by this
    // panel reaching around it.
    expect(fake.store.setPaletteSlot).not.toHaveBeenCalled();
  });

  it("recolours a slot from its swatch", async () => {
    contribute("Some.Printer", { provides: { [FILAMENTS]: filaments() } });
    const { w, fake } = await render([{ id: "b1" }]);
    const swatch = w.findAll(".pal-swatch")[1]!;
    (swatch.element as HTMLInputElement).value = "#00ff00";
    await swatch.trigger("change");
    expect(fake.store.setPaletteSlot).toHaveBeenCalledWith(1, { color: "#00ff00" });
  });

  it("goes amber when the machine has drifted from the palette", async () => {
    vi.useFakeTimers();
    contribute("Some.Printer", {
      provides: {
        [FILAMENTS]: filaments({
          read: () => Promise.resolve([slot({ color: "#00ff00" })]),
        }),
      },
    });
    setActivePinia(createPinia());
    const fake = fakeEngine([{ id: "b1" }]);
    const w = mount(PaletteSection, {
      global: { provide: { [ENGINE as symbol]: fake.engine } },
    });
    await vi.advanceTimersByTimeAsync(31_000);
    await nextTick();
    const dot = w.get(".pal-dot");
    expect(dot.attributes("title")).toContain("changed since sync");
    expect(dot.attributes("style")).toContain("#d2a83b");
  });
});
