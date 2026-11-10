// The rail's own buttons, cues and spoken states read in the chosen language, while every id the harness and the
// shortcuts match on stays English.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, nextTick, ref, shallowRef } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { useRibbonStore } from "../../../src/stores/ribbon";
import { setLanguage } from "../../../src/i18n";

const state = vi.hoisted(() => ({
  kind: "",
  sketch: { number: 0, name: "" },
  tools: 2,
}));

vi.mock("../../../src/composables/useSelectionOffers", () => ({
  useSelectionOffers: () => ({
    counts: shallowRef({}),
    kind: computed(() => state.kind),
    offers: computed(() => []),
    appOffers: computed(() => []),
    pluginGroups: computed(() => [
      {
        pluginId: "gears",
        name: "Gears",
        offers: ["spur", "rack", "worm"].slice(0, state.tools).map((n) => ({
          tool: `gears.${n}`,
          label: n,
          iconName: "gear",
          hint: "",
          pluginId: "gears",
        })),
      },
    ]),
    looks: computed(() => []),
    summary: computed(() => "3 bodies"),
    readout: computed(() => ""),
    toolOwns: ref(false),
    run: () => {},
    look: () => {},
    clear: () => {},
    wake: () => {},
  }),
}));

vi.mock("../../../src/app/useDoc", () => ({
  useDocValue: () => computed(() => state.sketch),
  useBuildValue: () => computed(() => false),
}));

import ToolRail from "../../../src/components/shell/ToolRail.vue";

enableAutoUnmount(afterEach);

const engine = {
  store: { onDocChange: () => () => {}, onBuild: () => () => {} },
  tools: { section: { active: false, picking: false }, measure: { active: false } },
  viewport: { selectedFaceSketchPlane: () => null, getSelectedBodies: () => [] },
  sketch: { active: false, constraintOptions: () => [] },
  handleAction: () => {},
  setStatus: vi.fn(),
} as unknown as Engine;

const mountRail = () =>
  mount(ToolRail, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
const settle = async () => {
  await nextTick();
  await nextTick();
};
const rail = () => document.querySelector<HTMLElement>("#toolrail")!;
const byAction = (a: string) => rail().querySelector<HTMLElement>(`[data-action="${a}"]`)!;
const attrs = (sel: string, attr: string) =>
  [...rail().querySelectorAll<HTMLElement>(sel)].map((e) => e.getAttribute(attr));

describe("the tool rail in another language", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    state.kind = "";
    state.sketch = { number: 0, name: "" };
    state.tools = 2;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await setLanguage("system");
  });

  it("names the landmark and the fixed model buttons in German, ids unchanged", async () => {
    await setLanguage("en");
    const w = mountRail();
    const ids = attrs("[data-action]", "data-action");
    const families = attrs("[data-family]", "data-family");
    expect(rail().getAttribute("aria-label")).toBe("Tools");
    expect(byAction("isolate").getAttribute("aria-label")).toBe("Isolate");
    await setLanguage("de");
    await settle();
    expect(rail().getAttribute("aria-label")).toBe("Werkzeuge");
    expect(rail().querySelector(".rail-bar")?.getAttribute("aria-label")).toBe("Werkzeuge");
    expect(byAction("search").getAttribute("aria-label")).toContain("Suchen");
    expect(byAction("isolate").getAttribute("aria-label")).toBe("Isolieren");
    expect(byAction("isolate").textContent).toContain("Isolieren");
    expect(byAction("isolate").textContent).toContain("Aus");
    expect(byAction("section").textContent).toContain("Schnittansicht");
    expect(byAction("measure").textContent).toContain("Messen");
    expect(attrs("[data-action]", "data-action")).toEqual(ids);
    expect(attrs("[data-family]", "data-family")).toEqual(families);
    w.unmount();
  });

  it("switches language while mounted with no remount, in a new sketch and a numbered one", async () => {
    await setLanguage("en");
    useRibbonStore().context = "sketch";
    useRibbonStore().sketchId = "s1";
    const w = mountRail();
    expect(byAction("finish").textContent).toContain("Exit Sketching");
    expect(byAction("finish").textContent).toContain("New sketch");
    expect(byAction("construction").textContent).toContain("Off");
    const el = byAction("finish");
    await setLanguage("de");
    await settle();
    expect(byAction("finish")).toBe(el);
    expect(el.textContent).toContain("Skizze beenden");
    expect(el.textContent).toContain("Neue Skizze");
    expect(byAction("construction").textContent).toContain("Konstruktion");
    expect(byAction("construction").textContent).toContain("Aus");
    state.sketch = { number: 3, name: "" };
    w.unmount();
    const w2 = mountRail();
    expect(byAction("finish").textContent).toContain("Skizze 3");
    w2.unmount();
    state.sketch = { number: 3, name: "Bracket" };
    const w3 = mountRail();
    expect(byAction("finish").textContent).toContain("Bracket");
    expect(byAction("finish").textContent).not.toContain("Skizze 3");
    w3.unmount();
  });

  it("reads Deselect All and the group tip for one and two tools in both languages", async () => {
    state.kind = "body";
    const tip = async (lang: string, tools: number) => {
      await setLanguage(lang);
      state.tools = tools;
      const w = mountRail();
      const out = {
        deselect: byAction("deselect").textContent?.replace(/\s+/g, " ").trim(),
        tip: rail().querySelector('[data-group="gears"]')?.getAttribute("title"),
      };
      w.unmount();
      return out;
    };
    expect(await tip("en", 1)).toEqual({ deselect: "Deselect AllEsc3 bodies", tip: "Gears · 1 tool" });
    expect((await tip("en", 3)).tip).toBe("Gears · 3 tools");
    expect(await tip("de", 1)).toMatchObject({ tip: "Gears · 1 Werkzeug" });
    expect((await tip("de", 2)).tip).toBe("Gears · 2 Werkzeuge");
    expect((await tip("de", 2)).deselect).toContain("Auswahl aufheben");
  });

  it("names a flyout grid in German and keeps the family and pick ids English through a switch", async () => {
    await setLanguage("de");
    const w = mountRail();
    const fam = rail().querySelector<HTMLElement>("[data-family]")!;
    expect(fam.getAttribute("data-family")).toBe("cat:CREATE");
    fam.click();
    await settle();
    const grid = document.querySelector<HTMLElement>(".rail-flyout-grid")!;
    const picks = () => [...grid.querySelectorAll("[data-pick]")].map((e) => e.getAttribute("data-pick"));
    const before = picks();
    expect(before.length).toBeGreaterThan(1);
    expect(grid.getAttribute("aria-label")).toBe(`Werkzeuge: ${fam.querySelector(".rail-label")!.textContent}`);
    await setLanguage("en");
    await settle();
    expect(grid.getAttribute("aria-label")).toBe(`${fam.querySelector(".rail-label")!.textContent} tools`);
    expect(picks()).toEqual(before);
    expect(fam.getAttribute("data-family")).toBe("cat:CREATE");
    w.unmount();
  });
});
