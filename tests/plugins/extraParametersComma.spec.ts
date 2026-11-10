// A check typed with a decimal comma in a comma language is stored with a point, add and edit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SetupPanel from "../../plugins/FundaCAD.ExtraParameters/SetupPanel.vue";
import { setupOpen } from "../../plugins/FundaCAD.ExtraParameters/state";
import { ENGINE } from "../../src/app/engineKey";
import { DocumentStore } from "../../src/document/store";
import { setLanguage } from "../../src/i18n";
import type { Engine } from "../../src/app/engine";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  setupOpen.value = false;
  vi.unstubAllGlobals();
  await setLanguage("system");
});

const backend = {
  rebuild: () => new Promise<never>(() => {}),
  async init() {},
  onStatus: () => () => {},
  onProgress: () => () => {},
  cancel: async () => true,
} as unknown as GeometryBackend;

const doc = (): CadDocument => ({
  parameters: {},
  paramDefs: { wall: { expr: "2", value: 2, unit: "mm" }, gap: { expr: "0.5", value: 0.5, unit: "mm" } },
  paramExtras: { checks: [{ id: "k1", expr: "gap >= 0.3", message: "thin", level: "warning" }] },
  features: [],
});

async function render() {
  setActivePinia(createPinia());
  const store = new DocumentStore(backend, doc());
  const docVersion = ref(0);
  store.onDocChange(() => void docVersion.value++);
  const engine = { store, bridge: { docVersion, buildVersion: ref(0), metaVersion: ref(0) } } as unknown as Engine;
  setupOpen.value = true;
  mount(SetupPanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  await flushPromises();
  await nextTick();
  return store;
}

const box = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
async function edit(input: HTMLInputElement, text: string) {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flushPromises();
}
async function addCheck(rule: string, message: string) {
  await edit(box("New check rule"), rule);
  await edit(box("New check message"), message);
  document.querySelector<HTMLButtonElement>('button[aria-label="Add check"]')!.click();
  await flushPromises();
}
const checks = (s: DocumentStore) => s.document.paramExtras?.checks?.map((c) => [c.expr, c.message]);

describe("checks typed with a decimal comma", () => {
  it("are stored with a point in German, added and edited", async () => {
    await setLanguage("de");
    const store = await render();
    await addCheck("wall * 1,5 > max(0,75; 1,25)", "wall too thin");
    expect(checks(store)).toEqual([
      ["gap >= 0.3", "thin"],
      ["wall * 1.5 > max(0.75; 1.25)", "wall too thin"],
    ]);
    await edit(box("Check 1 rule"), "gap >= 0,35");
    expect(checks(store)).toEqual([
      ["gap >= 0.35", "thin"],
      ["wall * 1.5 > max(0.75; 1.25)", "wall too thin"],
    ]);
  });

  it("are refused in English and nothing is stored", async () => {
    const store = await render();
    await addCheck("wall > 1,5", "wall too thin");
    await edit(box("Check 1 rule"), "gap >= 0,35");
    expect(checks(store)).toEqual([["gap >= 0.3", "thin"]]);
    expect(document.querySelector("[role=alert]")?.textContent).toMatch(/wall > 1,5/);
  });
});
