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
  paramDefs: {
    wall: { expr: "2", value: 2, unit: "mm" },
    gap: { expr: "0.5", value: 0.5, unit: "mm" },
    rib: { expr: "wall*1.5 + 0.25", value: 3.25, unit: "mm" },
    size: {
      expr: "10",
      value: 10,
      unit: "mm",
      control: {
        kind: "choice",
        choices: [
          { label: "Small", value: 10 },
          { label: "Large", value: 30 },
        ],
      },
    },
  },
  paramExtras: {
    checks: [{ id: "k1", expr: "gap >= 0.3", message: "thin", level: "warning" }],
    configurations: [{ id: "c1", name: "Heavy", values: { wall: "2.5", gap: "max(0.5;0.75)" } }],
  },
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

describe("the choices box", () => {
  const choices = (s: DocumentStore) => {
    const c = s.document.paramDefs!["size"]!.control;
    return c?.kind === "choice" ? c.choices : null;
  };
  const alert = () => document.querySelector("[role=alert]")?.textContent ?? null;

  it("in German takes a decimal comma with a semicolon between choices, and refuses 1.500 with the reason", async () => {
    await setLanguage("de");
    const store = await render();
    const shown = { value: box("size choices").value, placeholder: box("size choices").placeholder };
    await edit(box("size choices"), "Small = 2,5; Large = 30");
    const taken = { stored: choices(store), value: box("size choices").value, alert: alert() };
    await edit(box("size choices"), "Small = 1.500; Large = 30");
    expect({ shown, taken, refused: { stored: choices(store), alert: alert() } }).toEqual({
      shown: { value: "Small = 10; Large = 30", placeholder: "Small = 10; Large = 30" },
      taken: {
        stored: [
          { label: "Small", value: 2.5 },
          { label: "Large", value: 30 },
        ],
        value: "Small = 2,5; Large = 30",
        alert: null,
      },
      refused: {
        stored: [
          { label: "Small", value: 2.5 },
          { label: "Large", value: 30 },
        ],
        alert: expect.stringContaining('"1.500" is ambiguous, write a comma for decimals or leave the point out'),
      },
    });
  });

  it("in English keeps a comma between choices and reads 1.500 as 1.5", async () => {
    const store = await render();
    const shown = { value: box("size choices").value, placeholder: box("size choices").placeholder };
    await edit(box("size choices"), "Small = 1.500, Large = 30");
    expect({ shown, stored: choices(store), alert: alert() }).toEqual({
      shown: { value: "Small = 10, Large = 30", placeholder: "Small = 10, Large = 30" },
      stored: [
        { label: "Small", value: 1.5 },
        { label: "Large", value: 30 },
      ],
      alert: null,
    });
  });
});

describe("saved expressions in the setup panel", () => {
  const shown = () => [
    box("Check 1 rule").value,
    document.querySelector<HTMLElement>('[aria-label="Name of configuration Heavy"]')!.title,
    document.querySelector<HTMLElement>(".xp-param [title*='wall*1']")?.title,
  ];

  it("show with a decimal comma in German and a point again in English", async () => {
    await render();
    expect(shown()).toEqual(["gap >= 0.3", "wall = 2.5\ngap = max(0.5;0.75)", "wall*1.5 + 0.25 = 3.25"]);
    await setLanguage("de");
    await nextTick();
    expect(shown()).toEqual(["gap >= 0,3", "wall = 2,5\ngap = max(0,5;0,75)", "wall*1,5 + 0,25 = 3,25"]);
    await setLanguage("system");
    await nextTick();
    expect(shown()).toEqual(["gap >= 0.3", "wall = 2.5\ngap = max(0.5;0.75)", "wall*1.5 + 0.25 = 3.25"]);
  });

  it("commits an untouched check on blur as the same text", async () => {
    await setLanguage("de");
    const store = await render();
    await edit(box("Check 1 rule"), "gap >= 0,3");
    expect(checks(store)).toEqual([["gap >= 0.3", "thin"]]);
  });
});
