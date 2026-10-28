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
import { renderPrefs, setRenderPref } from "../../../src/ui/renderPrefs";
import type { Engine } from "../../../src/app/engine";
import { useHomeStore } from "../../../src/stores/home";
import type { HomeCallbacks } from "../../../src/ui/home";

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
    onReferenceImagesChange: () => () => {},
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
      h(RenderChoices, {
        label: "Mode",
        value: "a",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      }),
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
    expect(mine.find(".ui-slider input[type=range]").exists()).toBe(true);
    expect(mine.get(".ui-checkbox").classes()).toContain("is-on");
    expect(mine.findAll(".ui-segment.is-selected")).toHaveLength(1);
    expect(mine.get(".sm-hint").text()).toBe("plugin hint");
    off();
    await nextTick();
    expect(cam.find("[data-render-section]").exists()).toBe(false);
  });
});

describe("Render dock rows on the base controls", () => {
  it("RenderSlider updates live while dragging", async () => {
    const r = mount(RenderSlider, { props: { label: "Amount", value: 0.5, min: 0, max: 1 } });
    const input = r.get("input[type=range]");
    expect(input.attributes("aria-labelledby")).toBeTruthy();
    (input.element as HTMLInputElement).value = "0.7";
    await input.trigger("input");
    expect(r.emitted("update")).toEqual([[0.7]]);
  });

  it("RenderSwitch is a labelled checkbox that flips once on click and on Space", async () => {
    const r = mount(RenderSwitch, { props: { label: "Flag", value: true } });
    expect(r.get(".ui-checkbox-label").text()).toBe("Flag");
    await r.get("input").trigger("change");
    await r.get("input").trigger("keydown", { key: " " });
    expect(r.emitted("update")).toEqual([[false], [false]]);
  });

  it("RenderChoices is a radio group that emits the picked id", async () => {
    const options = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ];
    const r = mount(RenderChoices, { props: { label: "Mode", value: "a", options } });
    expect(r.get("[role=radiogroup]").attributes("aria-label")).toBe("Mode");
    const [a, b] = r.findAll("[role=radio]");
    expect(a!.attributes("aria-checked")).toBe("true");
    expect(a!.attributes("tabindex")).toBe("0");
    expect(b!.attributes("tabindex")).toBe("-1");
    await b!.trigger("click");
    await a!.trigger("click");
    expect(r.emitted("update")).toEqual([["b"]]);
  });

  it("the dock tabs are one Tab stop and the arrows move between them", async () => {
    const tabs = w.findAll("#renderdock [role=tab]");
    expect(tabs.map((t) => t.attributes("data-tab"))).toEqual(["material", "environment", "camera"]);
    expect(tabs.map((t) => t.attributes("tabindex"))).toEqual(["0", "-1", "-1"]);
    await tabs[0]!.trigger("keydown", { key: "ArrowRight" });
    expect(w.get('[role=tab][data-tab="environment"]').attributes("aria-selected")).toBe("true");
    expect(tabBody("environment").isVisible()).toBe(true);
  });

  describe("the Camera tab", () => {
    afterEach(() => setRenderPref("focusBlur", 0));

    it("keeps the blur live and the aperture greyed with a reason until blur is up", async () => {
      setRenderPref("focusBlur", 0);
      await nextTick();
      const aperture = w.get("#rd-aperture");
      expect(aperture.attributes("aria-disabled")).toBe("true");
      expect(aperture.attributes("title")).toMatch(/Blur/);
      const blur = w.get("#rd-blur input");
      (blur.element as HTMLInputElement).value = "0.4";
      await blur.trigger("input");
      expect(renderPrefs().focusBlur).toBe(0.4);
      await nextTick();
      expect(w.get("#rd-aperture").attributes("aria-disabled")).toBeUndefined();
      expect(w.get("#rd-blur .ui-slider-value").text()).toBe("0.40");
    });

    it("picks the picture size from radio chips that keep their data hooks", async () => {
      const one = w.get('[data-scale="1"]');
      expect(one.attributes("role")).toBe("radio");
      expect(w.get('[data-scale="2"]').attributes("aria-checked")).toBe("true");
      await one.trigger("click");
      expect(w.get('[data-scale="1"]').attributes("aria-checked")).toBe("true");
    });
  });
});

// Home covers #stage only, and the dock sat in its own track beside it, over Home.
describe("Render dock and Home", () => {
  const dock = () => w.find("#renderdock").exists();

  it("is put away while Home is up and back when Home closes on the same document", async () => {
    const home = useHomeStore();
    home.bind({} as HomeCallbacks);
    expect(dock()).toBe(true);
    home.visible = true;
    await nextTick();
    expect(dock()).toBe(false);
    home.visible = false;
    await nextTick();
    expect(dock()).toBe(true);
  });

  it("stays away in Model whether or not Home is up", async () => {
    const home = useHomeStore();
    home.bind({} as HomeCallbacks);
    setWorkspace("model");
    await nextTick();
    expect(dock()).toBe(false);
    home.visible = true;
    await nextTick();
    expect(dock()).toBe(false);
  });
});
