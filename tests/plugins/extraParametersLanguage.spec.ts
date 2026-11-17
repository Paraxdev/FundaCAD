// The Extra Parameters panels, their option lists and their refusals follow the chosen language.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ParametersSection from "../../plugins/FundaCAD.ExtraParameters/ParametersSection.vue";
import SetupPanel from "../../plugins/FundaCAD.ExtraParameters/SetupPanel.vue";
import { setupOpen } from "../../plugins/FundaCAD.ExtraParameters/state";
import { parseChoices } from "../../plugins/FundaCAD.ExtraParameters/view";
import { nameOf } from "./pluginA11y";
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
    wall: { expr: "2", value: 2, unit: "mm", control: { kind: "slider", min: 1, max: 5 } },
    gap: { expr: "0.2", value: 0.2, unit: "mm" },
  },
  paramExtras: {
    groups: [{ id: "g1", name: "Body" }],
    configurations: [{ id: "c1", name: "Heavy", values: { wall: "3" } }],
    activeConfiguration: "c1",
    checks: [{ id: "k1", expr: "gap >= 0.3", message: "gap too small", level: "error" }],
  },
  features: [],
});

function engineFor() {
  setActivePinia(createPinia());
  const store = new DocumentStore(backend, doc());
  const docVersion = ref(0);
  store.onDocChange(() => void docVersion.value++);
  return {
    store,
    engine: { store, bridge: { docVersion, buildVersion: ref(0), metaVersion: ref(0) } } as unknown as Engine,
  };
}

async function openSetup() {
  const { engine } = engineFor();
  setupOpen.value = true;
  mount(SetupPanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  await flushPromises();
  await nextTick();
}

const label = (text: string) =>
  [...document.querySelectorAll("[role=combobox], input, button, [aria-label]")].find(
    (el) => nameOf(el).split(",")[0] === text,
  ) ?? null;

describe("the setup panel", () => {
  it("reads in German, then in Japanese, without a remount", async () => {
    await setLanguage("de");
    await openSetup();
    expect(document.body.textContent).toContain("Steuerelemente");
    expect(document.body.textContent).toContain("Prüfungen");
    expect(label("Steuerelement von wall")).not.toBeNull();
    expect(label("Regel von Prüfung 1")).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Name der neuen Konfiguration"]')).not.toBeNull();
    expect(document.querySelector(".xp-apply")?.getAttribute("aria-label")).toBe("Heavy anwenden");
    expect(document.querySelector(".xp-kind")?.textContent).toContain("Schieberegler");

    await setLanguage("ja");
    await nextTick();
    expect(document.body.textContent).toContain("コントロール");
    expect(label("wall のコントロール")).not.toBeNull();
    expect(label("チェック 1 の条件")).not.toBeNull();
    expect(document.querySelector(".xp-apply")?.getAttribute("aria-label")).toBe("Heavy を適用");
    expect(document.querySelector(".xp-kind")?.textContent).toContain("スライダー");
    expect(document.body.textContent).toContain("Ctrl Z");
  });

  it("keeps what a maker typed as it is", async () => {
    await setLanguage("de");
    await openSetup();
    expect(label("Name der Konfiguration Heavy")).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Meldung von Prüfung 1"]')?.value).toBe(
      "gap too small",
    );
  });

  it("refuses a bad range in the chosen language", async () => {
    await setLanguage("de");
    await openSetup();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Minimum von wall"]')!;
    input.focus();
    input.value = "9";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushPromises();
    await nextTick();
    expect(document.querySelector("[role=alert]")?.textContent?.trim()).toBe("min muss unter max liegen");
  });
});

describe("the Parameters section", () => {
  it("reads its title, check rows and configuration row in the chosen language", async () => {
    await setLanguage("de");
    const { engine } = engineFor();
    const w = mount(ParametersSection, {
      global: { provide: { [ENGINE as symbol]: engine } },
      attachTo: document.body,
    });
    await nextTick();
    expect(w.text()).toContain("Konfiguration");
    expect(w.find(".xp-check").text()).toBe("Fehler: gap too small");
    expect(w.find(".xp-setup").attributes("aria-label")).toBe("Parameter einrichten");

    await setLanguage("ja");
    await nextTick();
    expect(w.text()).toContain("構成");
    expect(w.find(".xp-check").text()).toBe("エラー: gap too small");
    expect(w.find(".tree-caret").attributes("aria-label")).toBe("パラメーターを折りたたむ");
  });
});

describe("the choices box", () => {
  it("words its refusals in the chosen language and splits at the language's mark", async () => {
    await setLanguage("de");
    expect(parseChoices("Klein = 2,5; Groß = 30")).toEqual([
      { label: "Klein", value: 2.5 },
      { label: "Groß", value: 30 },
    ]);
    expect(parseChoices("Klein")).toBe("„Klein“ braucht eine Zahl, etwa Groß = 30");
    expect(parseChoices("a = 1 = 2")).toBe("„a = 1 = 2“ sind zwei Auswahlen, setzen Sie ; dazwischen");
    expect(parseChoices("")).toBe("Geben Sie mindestens eine Auswahl an");

    await setLanguage("ja");
    expect(parseChoices("")).toBe("選択肢を1つ以上入力してください");
    expect(parseChoices("小")).toBe("「小」には数値が必要です。例: 大 = 30");

    await setLanguage("en");
    expect(parseChoices("Small")).toBe('"Small" needs a number, like Large = 30');
  });
});
