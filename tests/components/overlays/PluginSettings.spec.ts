// A plugin's declared settings on the Plugins screen: under its own row behind
// a disclosure, read through the app's measure grammar, reset per property and
// per plugin, and found by a search across every plugin.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import PluginsSection from "../../../src/components/overlays/PluginsSection.vue";
import { contribute, resetContributions } from "../../../src/plugins/contrib";
import { definePluginSettings, type PluginSettings } from "../../../src/plugins/settings";
import { pluginFocus } from "../../../src/plugins/settingsFocus";

enableAutoUnmount(afterEach);

let a: PluginSettings;
let b: PluginSettings;

beforeEach(() => {
  localStorage.clear();
  a = definePluginSettings("Test.Alpha", {
    version: 1,
    props: [
      { key: "gap", type: "number", label: "Gap", unit: "length", default: 2, min: 0, max: 100 },
      { key: "mode", type: "enum", label: "Mode", default: "a", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { key: "extra", type: "boolean", label: "Extra", default: false, visibleWhen: (v) => v.mode === "b" },
    ],
  });
  b = definePluginSettings("Test.Beta", {
    version: 1,
    props: [{ key: "speed", type: "number", label: "Rotate speed", default: 1, min: 0, max: 5, step: 0.25 }],
  });
  const Custom = defineComponent({ render: () => h("div", { "data-custom": "" }, "custom part") });
  contribute("Test.Alpha", { settings: [{ key: "s", settings: a, component: Custom }] });
  contribute("Test.Beta", { settings: [{ key: "s", settings: b }] });
});

afterEach(() => {
  resetContributions();
  localStorage.clear();
});

const rowOf = (w: ReturnType<typeof mount>, id: string) => w.get(`[data-plugin-row="${id}"]`);

async function expand(w: ReturnType<typeof mount>, id: string) {
  await rowOf(w, id).get("[data-plugin-settings-toggle]").trigger("click");
  return rowOf(w, id).get(`[data-plugin-settings="${id}"]`);
}

describe("settings under a plugin's row", () => {
  it("are hidden until the row is expanded, then drawn from the schema with the plugin's own part below", async () => {
    const w = mount(PluginsSection);
    expect(rowOf(w, "Test.Alpha").find("[data-plugin-settings]").exists()).toBe(false);
    const panel = await expand(w, "Test.Alpha");
    expect(panel.find('[data-setting="gap"]').exists()).toBe(true);
    expect(panel.find('[data-setting="extra"]').exists()).toBe(false);
    expect(panel.find("[data-custom]").exists()).toBe(true);
  });

  it("reads a length through the measure grammar and refuses text that is not one", async () => {
    const w = mount(PluginsSection);
    const panel = await expand(w, "Test.Alpha");
    const input = panel.get('[data-setting="gap"] input');
    await input.setValue("1 in");
    await input.trigger("change");
    expect(a.get("gap")).toBeCloseTo(25.4, 9);

    await input.setValue("abc");
    await input.trigger("change");
    expect(a.get("gap")).toBeCloseTo(25.4, 9);
    expect(panel.get('[data-setting="gap"] [role=alert]').text().length).toBeGreaterThan(0);

    await input.setValue("500");
    expect(panel.get('[data-setting="gap"] [role=alert]').text()).toContain("at most 100");
  });

  it("steps a number by its step with the arrow keys, ten steps with Shift, and stops at its limits", async () => {
    const w = mount(PluginsSection);
    const input = (await expand(w, "Test.Beta")).get('[data-setting="speed"] input');
    await input.trigger("keydown", { key: "ArrowUp" });
    expect(b.get("speed")).toBe(1.25);
    await input.trigger("keydown", { key: "ArrowDown" });
    await input.trigger("keydown", { key: "ArrowDown" });
    expect(b.get("speed")).toBe(0.75);
    await input.trigger("keydown", { key: "ArrowUp", shiftKey: true });
    expect(b.get("speed")).toBe(3.25);
    await input.trigger("keydown", { key: "ArrowUp", shiftKey: true });
    expect(b.get("speed")).toBe(5);
    expect((input.element as HTMLInputElement).value).toBe("5");
  });

  it("shows a row once its condition holds, and resets one property or the whole plugin", async () => {
    const w = mount(PluginsSection);
    const panel = await expand(w, "Test.Alpha");
    await panel.get('[data-setting="mode"] select').setValue("b");
    expect(a.get("mode")).toBe("b");
    await nextTick();
    expect(panel.find('[data-setting="extra"]').exists()).toBe(true);

    await panel.get('[data-setting="mode"] [data-setting-reset]').trigger("click");
    expect(a.get("mode")).toBe("a");

    a.set("gap", 9);
    a.set("mode", "b");
    await rowOf(w, "Test.Alpha").get("[data-plugin-settings-reset]").trigger("click");
    expect(a.isDefault("gap") && a.isDefault("mode")).toBe(true);
  });

  it("finds settings across plugins and opens the rows that match", async () => {
    const w = mount(PluginsSection);
    await w.get("[data-plugin-settings-search]").setValue("rotate");
    expect(w.find('[data-plugin-row="Test.Alpha"]').exists()).toBe(false);
    expect(rowOf(w, "Test.Beta").find('[data-setting="speed"]').exists()).toBe(true);
    await w.get("[data-plugin-settings-search]").setValue("");
    expect(w.find('[data-plugin-row="Test.Alpha"]').exists()).toBe(true);
  });

  it("opens on the row a plugin asked for", async () => {
    pluginFocus.value = "Test.Beta";
    const w = mount(PluginsSection);
    await nextTick();
    expect(rowOf(w, "Test.Beta").find('[data-setting="speed"]').exists()).toBe(true);
    expect(pluginFocus.value).toBeNull();
  });

  it("refuses a plugin contributing another plugin's settings", () => {
    expect(() => contribute("Test.Beta", { settings: [{ key: "x", settings: a }] })).toThrow(/settings of Test.Alpha/);
  });
});
