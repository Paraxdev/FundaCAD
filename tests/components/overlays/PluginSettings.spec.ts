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
import { setUnit } from "../../../src/ui/units";

enableAutoUnmount(afterEach);

let a: PluginSettings;
let b: PluginSettings;

beforeEach(() => {
  localStorage.clear();
  a = definePluginSettings("Test.Alpha", {
    version: 1,
    props: [
      { key: "gap", type: "number", label: "Gap", unit: "length", default: 2, min: 0, max: 100 },
      {
        key: "mode",
        type: "enum",
        label: "Mode",
        default: "a",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
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
    expect(a.get("gap")).toBe(2);
    await input.trigger("keydown", { key: "Enter" });
    expect(a.get("gap")).toBeCloseTo(25.4, 9);

    await input.setValue("abc");
    await input.trigger("keydown", { key: "Enter" });
    expect(a.get("gap")).toBeCloseTo(25.4, 9);
    expect(panel.get('[data-setting="gap"] [role=alert]').text().length).toBeGreaterThan(0);
    expect(input.attributes("aria-invalid")).toBe("true");

    await input.setValue("500");
    expect(panel.find('[data-setting="gap"] [role=alert]').exists()).toBe(false);
    await input.trigger("blur");
    expect(panel.get('[data-setting="gap"] [role=alert]').text()).toMatch(/at most 100/i);
    expect(a.get("gap")).toBeCloseTo(25.4, 9);
  });

  it("steps a number by its step with the arrow keys, ten steps with Shift, and stops at its limits", async () => {
    const w = mount(PluginsSection);
    const input = (await expand(w, "Test.Beta")).get('[data-setting="speed"] input');
    const el = input.element as HTMLInputElement;
    await input.trigger("keydown", { key: "ArrowUp" });
    expect(el.value).toBe("1.25");
    await input.trigger("keydown", { key: "Enter" });
    expect(b.get("speed")).toBe(1.25);
    await input.trigger("keydown", { key: "ArrowDown" });
    await input.trigger("keydown", { key: "ArrowDown" });
    await input.trigger("keydown", { key: "Enter" });
    expect(b.get("speed")).toBe(0.75);
    await input.trigger("keydown", { key: "ArrowUp", shiftKey: true });
    await input.trigger("blur");
    expect(b.get("speed")).toBe(3.25);
    await input.trigger("keydown", { key: "ArrowUp", shiftKey: true });
    await input.trigger("keydown", { key: "Enter" });
    expect(b.get("speed")).toBe(5);
    await nextTick();
    expect(el.value).toBe("5");
  });

  it("holds an arrow step as a draft until Enter or blur, and Escape takes it back", async () => {
    const w = mount(PluginsSection);
    const input = (await expand(w, "Test.Beta")).get('[data-setting="speed"] input');
    await input.trigger("keydown", { key: "ArrowUp" });
    await input.trigger("keydown", { key: "ArrowUp" });
    expect(b.get("speed")).toBe(1);
    await input.trigger("keydown", { key: "Escape" });
    expect((input.element as HTMLInputElement).value).toBe("1");
    await input.trigger("blur");
    expect(b.get("speed")).toBe(1);
  });

  it("shows a row once its condition holds, and resets one property or the whole plugin", async () => {
    const w = mount(PluginsSection);
    const panel = await expand(w, "Test.Alpha");
    expect(panel.find("select").exists()).toBe(false);
    expect(panel.find('[data-setting="gap"] .ui-number-field input').exists()).toBe(true);
    await panel.get('[data-setting="mode"] .select-trigger').trigger("click");
    const rows = [...document.body.querySelectorAll<HTMLElement>(".select-pop .opt-row")];
    expect(rows.map((r) => r.textContent?.trim())).toEqual(["A", "B"]);
    rows[1]!.click();
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

describe("each kind of schema field", () => {
  let k: PluginSettings;

  beforeEach(() => {
    k = definePluginSettings("Test.Kinds", {
      version: 1,
      props: [
        { key: "gap", type: "number", label: "Gap", unit: "length", default: 25.4, step: 2.54 },
        { key: "tilt", type: "number", label: "Tilt", unit: "angle", default: 10, step: 5 },
        { key: "count", type: "number", label: "Count", unit: "in", default: 4, integer: true, min: 1 },
        { key: "on", type: "boolean", label: "Snap", default: false },
        { key: "name", type: "string", label: "Name", default: "a", placeholder: "Untitled", maxLength: 8 },
        { key: "tint", type: "colour", label: "Tint", default: "#ff8800" },
        { key: "hotkey", type: "key", label: "Shortcut", default: "Ctrl+K" },
        { key: "path", type: "file", label: "Template", default: "" },
      ],
    });
    contribute("Test.Kinds", { settings: [{ key: "s", settings: k }] });
  });

  afterEach(() => setUnit("mm"));

  const field = async (key: string) => {
    const w = mount(PluginsSection, { attachTo: document.body });
    return (await expand(w, "Test.Kinds")).get(`[data-setting="${key}"]`);
  };

  it("shows a length in the display unit and steps it by its declared step", async () => {
    setUnit("in");
    const row = await field("gap");
    const input = row.get("input");
    expect((input.element as HTMLInputElement).value).toBe("1");
    expect(row.get(".ui-unit-chip").text()).toBe("in");
    await input.trigger("keydown", { key: "ArrowUp" });
    await input.trigger("keydown", { key: "Enter" });
    expect(k.get("gap")).toBeCloseTo(27.94, 6);
    await input.setValue("2");
    await input.trigger("keydown", { key: "Enter" });
    expect(k.get("gap")).toBeCloseTo(50.8, 6);
  });

  it("shows an angle in degrees with its step", async () => {
    const row = await field("tilt");
    expect(row.get(".ui-unit-chip").text()).toBe("°");
    await row.get("input").trigger("keydown", { key: "ArrowDown", shiftKey: true });
    await row.get("input").trigger("keydown", { key: "Enter" });
    expect(k.get("tilt")).toBe(-40);
  });

  it("keeps any other unit a caption beside a plain whole number", async () => {
    const row = await field("count");
    const input = row.get("input");
    expect((input.element as HTMLInputElement).value).toBe("4");
    expect(row.get(".ui-unit-chip").text()).toBe("in");
    await input.trigger("keydown", { key: "ArrowUp" });
    await input.trigger("keydown", { key: "Enter" });
    expect(k.get("count")).toBe(5);
    await input.setValue("2.5");
    await input.trigger("keydown", { key: "Enter" });
    expect(k.get("count")).toBe(5);
    expect(row.get("[role=alert]").text()).toMatch(/whole number/);
    await input.setValue("0");
    await input.trigger("keydown", { key: "Enter" });
    expect(row.get("[role=alert]").text()).toMatch(/at least 1/i);
  });

  it("toggles a boolean with its checkbox, and once from its title", async () => {
    const row = await field("on");
    const box = row.get(".ui-checkbox input");
    expect(box.attributes("aria-label")).toBe("Snap");
    await box.trigger("change");
    expect(k.get("on")).toBe(true);
    await box.trigger("keydown", { key: " " });
    expect(k.get("on")).toBe(false);
    (row.get(".pref-title").element as HTMLElement).click();
    expect(k.get("on")).toBe(true);
  });

  it("commits text on Enter or blur, and Escape takes it back", async () => {
    const row = await field("name");
    const input = row.get("input");
    expect(input.attributes("placeholder")).toBe("Untitled");
    expect(input.attributes("maxlength")).toBe("8");
    expect(row.get(".pref-title").attributes("for")).toBe(input.attributes("id"));
    await input.setValue("bolt");
    expect(k.get("name")).toBe("a");
    await input.trigger("keydown", { key: "Enter" });
    expect(k.get("name")).toBe("bolt");
    await input.setValue("nut");
    await input.trigger("keydown", { key: "Escape" });
    await input.trigger("blur");
    expect(k.get("name")).toBe("bolt");
    await input.setValue("washer");
    await input.trigger("blur");
    expect(k.get("name")).toBe("washer");
  });

  it("stores a picked colour", async () => {
    const input = (await field("tint")).get("input[type=color]");
    await input.setValue("#00ff00");
    expect(k.get("tint")).toBe("#00ff00");
  });

  it("captures a key combination, and clears it with Backspace", async () => {
    const row = await field("hotkey");
    const key = row.get("button.plugset-key");
    expect(row.get(".pref-title").attributes("for")).toBe(key.attributes("id"));
    await key.trigger("focus");
    expect(key.text()).toBe("Press a key…");
    await key.trigger("keydown", { key: "j", ctrlKey: true, shiftKey: true });
    expect(k.get("hotkey")).toBe("Ctrl+Shift+J");
    await key.trigger("keydown", { key: "Backspace" });
    expect(k.get("hotkey")).toBe("");
  });

  it("commits a typed file path", async () => {
    const input = (await field("path")).get("input");
    await input.setValue("C:/parts/a.funda");
    await input.trigger("blur");
    expect(k.get("path")).toBe("C:/parts/a.funda");
  });

  it("names its reset button as before and hides it at the default", async () => {
    const row = await field("name");
    const reset = row.get("[data-setting-reset]");
    expect(reset.attributes("title")).toBe("Reset Name to its default");
    expect(reset.attributes("aria-label")).toBe("Reset Name");
    expect(reset.classes()).toContain("hidden");
    k.set("name", "x");
    await nextTick();
    expect(reset.classes()).not.toContain("hidden");
    await reset.trigger("click");
    expect(k.get("name")).toBe("a");
  });
});
