// A parameter is one row under Parameters, whatever language is shown and however many documents were loaded.

import { afterEach, describe, expect, it } from "vitest";
import { nextTick, ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import ParametersSection from "../../plugins/FundaCAD.ExtraParameters/ParametersSection.vue";
import { ENGINE } from "../../src/app/engineKey";
import { DocumentStore } from "../../src/document/store";
import type { Engine } from "../../src/app/engine";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { setLanguage } from "../../src/i18n";

afterEach(() => setLanguage("system"));

const backend = {
  async rebuild() {
    return new Promise<never>(() => {});
  },
  async init() {},
  onStatus: () => () => {},
  onProgress: () => () => {},
  async cancel() {
    return true;
  },
} as unknown as GeometryBackend;

const docA = (): CadDocument => ({
  parameters: {},
  paramDefs: {
    base: { expr: "2.5", value: 2.5, unit: "mm" },
    fx: { expr: "base", value: 2.5, unit: "mm" },
    angle: { expr: "37", value: 37, unit: "deg", group: "g1" },
    tilt: { expr: "angle * 2", value: 74, unit: "deg", group: "g1" },
  },
  paramExtras: { groups: [{ id: "g1", name: "Core" }] },
  features: [],
});

const docB = (): CadDocument => ({
  parameters: {},
  paramDefs: {
    wall: { expr: "1.75", value: 1.75, unit: "mm" },
    fx: { expr: "wall * 2", value: 3.5, unit: "mm" },
  },
  features: [],
});

async function render() {
  setActivePinia(createPinia());
  const store = new DocumentStore(backend, docA());
  const docVersion = ref(0);
  store.onDocChange(() => {
    docVersion.value++;
  });
  const engine = { store, bridge: { docVersion, buildVersion: ref(0), metaVersion: ref(0) } } as unknown as Engine;
  const w = mount(ParametersSection, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  await nextTick();
  return { w, store };
}

const settle = async () => {
  await flushPromises();
  await nextTick();
};

describe("a parameter shows once under Parameters", () => {
  it("has one row per parameter, before and after a language change and a second document", async () => {
    const { w, store } = await render();
    const names = () => w.findAll(".xp-row").map((r) => r.attributes("data-param"));
    expect(names()).toEqual(["base", "fx", "angle", "tilt"]);

    await setLanguage("de");
    await settle();
    expect(names()).toEqual(["base", "fx", "angle", "tilt"]);
    expect(w.findAll(".xp-row").filter((r) => r.text().includes("fx 2,5"))).toHaveLength(1);

    store.loadDocument(docB(), { replace: true });
    await settle();
    expect(names()).toEqual(["wall", "fx"]);
    await setLanguage("en");
    await settle();
    expect(names()).toEqual(["wall", "fx"]);
    w.unmount();
  });
});
