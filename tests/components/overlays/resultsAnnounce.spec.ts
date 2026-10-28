import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../../../src/ui/announce", () => ({ announce: vi.fn() }));

import MeasureReadout from "../../../src/components/overlays/MeasureReadout.vue";
import StressVerdict from "../../../src/components/overlays/StressVerdict.vue";
import { useToolPanelStore } from "../../../src/stores/toolPanels";
import { verdictView } from "../../../src/ui/stressVerdict";
import { announce } from "../../../src/ui/announce";

enableAutoUnmount(afterEach);
const said = () => vi.mocked(announce).mock.calls;

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  vi.mocked(announce).mockClear();
});

describe("Measure speech", () => {
  it("speaks the rows as one sentence each time the result changes, and nothing when the tool stops", async () => {
    mount(MeasureReadout, { attachTo: document.body });
    const panels = useToolPanelStore();
    panels.measure = [{ k: "", v: "Pick a face or edge" }];
    await nextTick();
    panels.measure = [
      { k: "Distance", v: "12.5 mm" },
      { k: "Angle", v: "90°" },
    ];
    await nextTick();
    panels.measure = null;
    await nextTick();
    expect(said()).toEqual([
      [" Pick a face or edge", "polite", { key: "measure", delay: 150 }],
      ["Distance 12.5 mm, Angle 90°", "polite", { key: "measure", delay: 150 }],
    ]);
  });
});

describe("Stress verdict speech", () => {
  const props = { marked: true, scale: null, maxDeflection: null, unit: "mm" as const };

  it("speaks the verdict as it appears and again when a new result changes it", async () => {
    const w = mount(StressVerdict, { props: { ...props, input: { safetyFactor: 4 } } });
    const first = verdictView({ safetyFactor: 4 });
    expect(said()[0]?.[0]).toBe([first.headline, first.detail].filter(Boolean).join(". "));
    expect(said()[0]?.slice(1)).toEqual(["polite", { key: "stress" }]);
    await w.setProps({ input: { safetyFactor: 0.5 } });
    const second = verdictView({ safetyFactor: 0.5 });
    expect(second.headline).not.toBe(first.headline);
    expect(said()[1]?.[0]).toContain(second.headline);
  });
});
