// A plugin's Render dock sections land at the end of the tab they name, follow the
// plugin in and out, and can be drawn from the dock's own rows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import RenderDock from "../../../src/components/shell/RenderDock.vue";
import { RenderChoices, RenderSection, RenderSlider, RenderSwitch } from "../../../src/plugins/hostUi";
import { contribute, resetContributions } from "../../../src/plugins/contrib";
import { ENGINE } from "../../../src/app/engineKey";
import { setWorkspace } from "../../../src/ui/workspace";
import type { Engine } from "../../../src/app/engine";

vi.mock("../../../src/viewport/materialPreview", () => ({
  materialPreview: () => null,
  onPreviewsChanged: () => () => {},
}));

const engine = {
  store: {
    materialLibrary: [],
    bodyMaterialId: () => undefined,
    faceMaterialId: () => undefined,
    faceMaterialEntries: () => [],
    buildState: { building: false, result: { bodies: [] } },
  },
  bridge: { buildVersion: ref(0) },
  viewport: {
    getSelectedFaceIds: () => [],
    tracedPictureSize: () => null,
    qualityTier: () => ({ lowPower: false, auto: false, software: false }),
    onRenderTierChange: () => () => {},
  },
  tools: {},
  canvas: { getBoundingClientRect: () => ({ width: 100, height: 100 }) },
} as unknown as Engine;

const Mine = defineComponent({
  render: () =>
    h(RenderSection, { title: "Mine", hint: "plugin hint" }, () => [
      h(RenderSlider, { label: "Amount", value: 0.5, min: 0, max: 1 }),
      h(RenderSwitch, { label: "Flag", value: true }),
      h(RenderChoices, { label: "Mode", value: "a", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }),
    ]),
});

let w: VueWrapper;
const tabBody = (tab: string) => w.findAll(".rd-scroll")[["material", "environment", "camera"].indexOf(tab)]!;

beforeEach(() => {
  setActivePinia(createPinia());
  setWorkspace("render");
  w = mount(RenderDock, { global: { provide: { [ENGINE as symbol]: engine } } });
});
afterEach(() => {
  w.unmount();
  resetContributions();
  setWorkspace("model");
});

describe("Render dock sections from a plugin", () => {
  it("mounts at the end of the named tab only", async () => {
    contribute("P.One", { renderSections: [{ key: "mine", component: Mine, tab: "environment" }] });
    await nextTick();
    const env = tabBody("environment");
    expect(env.findAll("[data-render-section]")).toHaveLength(1);
    expect(tabBody("material").find("[data-render-section]").exists()).toBe(false);
    expect(tabBody("camera").find("[data-render-section]").exists()).toBe(false);
    const sections = env.findAll(":scope > section");
    expect(sections[sections.length - 1]!.find(".rd-head").text()).toBe("Mine");
  });

  it("draws the dock's own rows and leaves with the plugin", async () => {
    const off = contribute("P.One", { renderSections: [{ key: "mine", component: Mine, tab: "camera" }] });
    await nextTick();
    const cam = tabBody("camera");
    const mine = cam.get("[data-render-section]");
    expect(mine.find("input.sm-slider").exists()).toBe(true);
    expect(mine.findAll(".rd-chip.active")).toHaveLength(2);
    expect(mine.get(".sm-hint").text()).toBe("plugin hint");
    off();
    await nextTick();
    expect(cam.find("[data-render-section]").exists()).toBe(false);
  });
});
