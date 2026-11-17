// The filament palette and the body Color menu speak the language through the plugin's own lines.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import PaletteSection from "../../plugins/FundaCAD.MultiColor/PaletteSection.vue";
import { FILAMENTS, bodyColorMenu } from "../../plugins/FundaCAD.MultiColor/palette";
import { activate } from "../../plugins/FundaCAD.MultiColor/main";
import type { Engine } from "../../src/app/engine";
import { ENGINE } from "../../src/app/engineKey";
import type { DocumentStore } from "../../src/document/store";
import { reloadLanguageFiles, setLanguage } from "../../src/i18n";
import { contribute, contributedBrowserSections, resetContributions } from "../../src/plugins/contrib";

enableAutoUnmount(afterEach);

beforeEach(async () => {
  localStorage.clear();
  await setLanguage("en");
});

afterEach(async () => {
  resetContributions();
  vi.useRealTimers();
  localStorage.clear();
  await reloadLanguageFiles();
  await setLanguage("system");
});

const palette = [
  { name: "Polymaker PLA", color: "#d23b30", material: "PLA" },
  { name: "Toolhead 2", color: "#e8e8e8" },
];

function fakeEngine() {
  const store = {
    document: { parameters: {}, features: [] },
    buildState: { building: false, errorFeatureId: null, result: { bodies: [{ id: "b1" }] } },
    colorPalette: palette,
    setPaletteSlot: vi.fn(),
  };
  return {
    bridge: { docVersion: ref(0), buildVersion: ref(0), metaVersion: ref(0) },
    store,
  } as unknown as Engine;
}

function machine(color = "#d23b30") {
  contribute("Some.Printer", {
    provides: {
      [FILAMENTS]: {
        probe: () => Promise.resolve(true),
        read: () =>
          Promise.resolve([
            { index: 0, present: true, vendor: "Polymaker", material: "PLA", color },
            { index: 1, present: true, vendor: "Acme", material: "PETG", color },
          ]),
        sync: () => Promise.resolve(true),
      },
    },
  });
}

async function open() {
  setActivePinia(createPinia());
  const w = mount(PaletteSection, {
    attachTo: document.body,
    global: { provide: { [ENGINE as symbol]: fakeEngine() } },
  });
  for (let i = 0; i < 20 && !w.find(".pal-dot").exists(); i++) await nextTick();
  return w;
}

const menuStore = (slot: number | null) =>
  ({
    colorPalette: palette,
    bodyColorSlot: () => slot ?? undefined,
    setBodyColorSlot: vi.fn(),
  }) as unknown as DocumentStore;

describe("the Color menu of a body", () => {
  it("reads English, German and Japanese, and keeps its English names", async () => {
    const [color] = bodyColorMenu(menuStore(null), "b1");
    expect([color!.label, color!.refName]).toEqual(["Color", "Color"]);
    await setLanguage("de");
    const de = bodyColorMenu(menuStore(null), "b1")[0]!;
    expect([de.label, de.refName]).toEqual(["Farbe", "Color"]);
    expect(de.children!.at(-1)!.label).toBe("Keine");
    expect(de.children!.at(-1)!.refName).toBe("None");
    await setLanguage("ja");
    const ja = bodyColorMenu(menuStore(null), "b1")[0]!;
    expect(ja.label).toBe("カラー");
    expect(ja.children!.at(-1)!.label).toBe("なし");
    expect(ja.children!.slice(0, 2).map((i) => i.label)).toEqual(["Polymaker PLA", "Toolhead 2"]);
  });
});

describe("the filament palette", () => {
  it("reads German then Japanese after a switch, controls and tips included", async () => {
    machine();
    const w = await open();
    const sync = () => w.find(".pal-sync").attributes("aria-label");
    const slotTitle = () => w.findAll("[role=listitem]").map((r) => r.attributes("title"));
    expect(sync()).toBe("Sync filaments from printer");
    expect(slotTitle()).toEqual(["Filament slot 1 → toolhead 1 (PLA)", "Filament slot 2 → toolhead 2"]);

    await setLanguage("de");
    await nextTick();
    expect(sync()).toBe("Filamente vom Drucker abgleichen");
    expect(w.text()).toContain("Palette");
    expect(w.find("[role=list]").attributes("aria-label")).toBe("Filamentplätze");
    expect(w.find(".pal-dot").attributes("title")).toBe("Druckerverbindung");
    expect(slotTitle()).toEqual(["Filamentplatz 1 → Werkzeugkopf 1 (PLA)", "Filamentplatz 2 → Werkzeugkopf 2"]);
    expect(w.findAll(".pal-swatch").map((s) => s.attributes("aria-label"))).toEqual([
      "Farbe von Polymaker PLA",
      "Farbe von Toolhead 2",
    ]);

    await setLanguage("ja");
    await nextTick();
    expect(sync()).toBe("プリンターからフィラメントを同期");
    expect(w.find(".tree-caret").attributes("aria-label")).toBe("パレットを折りたたむ");
    expect(slotTitle()[0]).toBe("フィラメントスロット 1 → ツールヘッド 1 (PLA)");
  });

  it("says in the chosen language that the machine drifted, with a plural per slot count", async () => {
    vi.useFakeTimers();
    machine("#00ff00");
    await setLanguage("de");
    setActivePinia(createPinia());
    mount(PaletteSection, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: fakeEngine() } } });
    await vi.advanceTimersByTimeAsync(31_000);
    await nextTick();
    const alert = document.body.querySelector("[role=alert]")!.textContent!;
    expect(alert).toMatch(/^Warnung: Die Filamente des Druckers haben sich seit dem Abgleich geändert \(Plätze 1, 2\)/);
    await setLanguage("fr");
    await nextTick();
    expect(document.body.querySelector("[role=alert]")!.textContent).toMatch(/^Avertissement : Les filaments/);
  });
});

describe("the palette row of the browser tree", () => {
  it("names itself in the language after a switch", async () => {
    const off = await activate(fakeEngine());
    const row = () =>
      contributedBrowserSections()
        .find((s) => s.key === "FundaCAD.MultiColor:palette")
        ?.section.label?.();
    expect(row()).toBe("Palette");
    await setLanguage("ja");
    expect(row()).toBe("パレット");
    await setLanguage("zh-CN");
    expect(row()).toBe("调色板");
    off();
  });
});
