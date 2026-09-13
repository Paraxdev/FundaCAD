// The Parameters section, mounted against a real DocumentStore: the controls it
// draws come from the document, and turning one writes a parameter value that
// the store evaluates, clamps through the control, and can undo.

import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import ParametersSection from "../../plugins/FundaCAD.ExtraParameters/ParametersSection.vue";
import { setupOpen } from "../../plugins/FundaCAD.ExtraParameters/state";
import { ENGINE } from "../../src/app/engineKey";
import { DocumentStore } from "../../src/document/store";
import type { Engine } from "../../src/app/engine";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

afterEach(() => {
  setupOpen.value = false;
  vi.useRealTimers();
});

const backend = {
  async rebuild() { return new Promise<never>(() => {}); },
  async init() {},
  onStatus() { return () => {}; },
  onProgress() { return () => {}; },
  async cancel() { return true; },
} as unknown as GeometryBackend;

function fidget(): CadDocument {
  return {
    parameters: {},
    paramDefs: {
      solidCore: { expr: "1", value: 1, unit: "count", group: "g1", control: { kind: "toggle" } },
      joinedRings: { expr: "2", value: 2, unit: "count", group: "g1", control: { kind: "slider", min: 0, max: 22, step: 1 } },
      gap: { expr: "0.5", value: 0.5, unit: "mm", control: { kind: "number", min: 0.3, step: 0.1 } },
      pitch: { expr: "gap * 2", value: 1, unit: "mm" },
      helper: { expr: "7", value: 7, unit: "mm", hidden: true },
    },
    paramExtras: {
      groups: [{ id: "g1", name: "Core" }],
      configurations: [
        { id: "c1", name: "Classic", values: { solidCore: "0", joinedRings: "0" } },
        { id: "c2", name: "Button", values: { solidCore: "1", joinedRings: "3" } },
      ],
      checks: [{ id: "k1", expr: "gap >= 0.3", message: "gap below 0.3 mm fuses", level: "warning" }],
    },
    features: [],
  };
}

async function render() {
  setActivePinia(createPinia());
  const store = new DocumentStore(backend, fidget());
  const docVersion = ref(0);
  store.onDocChange(() => { docVersion.value++; });
  const engine = { store, bridge: { docVersion, buildVersion: ref(0), metaVersion: ref(0) } } as unknown as Engine;
  const w = mount(ParametersSection, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  await nextTick();
  return { w, store };
}

const settle = async () => {
  await flushPromises();
  await nextTick();
};

describe("the Parameters section", () => {
  it("draws each visible user parameter through its control, in its group", async () => {
    const { w } = await render();
    const rows = w.findAll(".xp-row").map((r) => r.attributes("data-param"));
    expect(rows).toEqual(["gap", "pitch", "solidCore", "joinedRings"]);
    expect(w.find('[data-param="solidCore"] input[type="checkbox"]').exists()).toBe(true);
    expect(w.find('[data-param="joinedRings"] input[type="range"]').exists()).toBe(true);
    expect(w.find('[data-param="gap"] input[type="number"]').exists()).toBe(true);
    // a formula has no control, it is reported
    expect(w.find('[data-param="pitch"] input').exists()).toBe(false);
    expect(w.find('[data-param="pitch"]').text()).toContain("fx 1");
    expect(w.text()).toContain("Core");
    expect(w.findAll(".xp-check")).toHaveLength(0); // the check holds
  });

  it("a toggle writes 0, a typed number is clamped by its control, and a failing check shows", async () => {
    const { w, store } = await render();
    await w.find('[data-param="solidCore"] input[type="checkbox"]').setValue(false);
    await settle();
    expect(store.document.paramDefs!["solidCore"]!.expr).toBe("0");

    const gap = w.find('[data-param="gap"] input[type="number"]');
    (gap.element as HTMLInputElement).value = "0.1";
    await gap.trigger("change");
    await settle();
    expect(store.document.paramDefs!["gap"]!.expr).toBe("0.3"); // not below its minimum

    // the check only fails when the value gets there some other way
    expect(store.setParamExpr("gap", "0.2")).toBeNull();
    await settle();
    expect(w.findAll(".xp-check").map((c) => c.text())).toEqual(["gap below 0.3 mm fuses"]);
    expect(w.find('[data-param="gap"]').attributes("title")).toMatch(/below the minimum/);
  });

  it("a slider commits once when it is let go, and a configuration applies and reports drift", async () => {
    const { w, store } = await render();
    const slider = w.find('[data-param="joinedRings"] input[type="range"]');
    for (const v of ["3", "4", "5"]) {
      (slider.element as HTMLInputElement).value = v;
      await slider.trigger("input");
    }
    expect(store.document.paramDefs!["joinedRings"]!.expr).toBe("2"); // nothing written mid-drag
    expect(w.find('[data-param="joinedRings"]').text()).toContain("5");
    await slider.trigger("change");
    await settle();
    expect(store.document.paramDefs!["joinedRings"]!.expr).toBe("5");

    await w.find(".xp-config").setValue("c2");
    await settle();
    expect(store.document.paramDefs!["joinedRings"]!.expr).toBe("3");
    expect(w.text()).not.toContain("modified");
    store.setParamExpr("joinedRings", "4");
    await settle();
    expect(w.text()).toContain("modified");

    await w.find(".xp-setup").trigger("click");
    expect(setupOpen.value).toBe(true);
  });
});
