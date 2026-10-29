import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";

import Checkbox from "../../../src/components/ui/Checkbox.vue";
import NumberField from "../../../src/components/ui/NumberField.vue";
import Select from "../../../src/components/ui/Select.vue";
import Slider from "../../../src/components/ui/Slider.vue";
import TextField from "../../../src/components/ui/TextField.vue";
import { useName, type NameProps } from "../../../src/components/ui/useName";

enableAutoUnmount(afterEach);

const Probe = defineComponent({
  inheritAttrs: false,
  props: { label: String, labelledby: String, tip: String, slotted: Boolean },
  setup(props: NameProps & { slotted: boolean }) {
    const name = useName(props, "Probe", () => props.slotted);
    return () => h("button", name.value);
  },
});

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const warned = () => warn.mock.calls.some((c) => String(c[0]).includes("Probe has no name"));

describe("useName", () => {
  it("warns in a dev build when a control has no name", () => {
    mount(Probe);
    expect(warned()).toBe(true);
  });

  it.each<[string, { props?: Record<string, unknown>; attrs?: Record<string, string> }]>([
    ["a label", { props: { label: "Radius" } }],
    ["a labelledby", { props: { labelledby: "radius-label" } }],
    ["an aria-label attribute", { attrs: { "aria-label": "Radius" } }],
    ["an aria-labelledby attribute", { attrs: { "aria-labelledby": "radius-label" } }],
    ["a name from elsewhere", { props: { slotted: true } }],
  ])("stays quiet given %s", (_, opts) => {
    mount(Probe, opts);
    expect(warned()).toBe(false);
  });

  it("names the element by its label, or by labelledby alone when both are given", async () => {
    const w = mount(Probe, { props: { label: "Radius" } });
    expect([w.attributes("aria-label"), w.attributes("aria-labelledby")]).toEqual(["Radius", undefined]);
    await w.setProps({ labelledby: "radius-label" });
    expect([w.attributes("aria-label"), w.attributes("aria-labelledby")]).toEqual([undefined, "radius-label"]);
  });

  it("passes an attribute name through for a plugin that skips the type check", () => {
    const w = mount(Probe, { attrs: { "aria-label": "Depth" } });
    expect(w.attributes("aria-label")).toBe("Depth");
  });

  it("falls back to the tip when nothing else names the control, and still warns", () => {
    const w = mount(Probe, { props: { tip: "Depth" } });
    expect([w.attributes("aria-label"), warned()]).toEqual(["Depth", true]);
  });

  it("names the element by its label or labelledby over the tip", () => {
    const label = mount(Probe, { props: { label: "Radius", tip: "Hole radius" } });
    const by = mount(Probe, { props: { labelledby: "radius-label", tip: "Hole radius" } });
    expect([label.attributes("aria-label"), by.attributes("aria-label"), by.attributes("aria-labelledby")]).toEqual([
      "Radius",
      undefined,
      "radius-label",
    ]);
  });
});

// A JS plugin skips the type check, and a release build has no warning, so a tip it used as the name must still name.
describe("a base control named by its tip alone", () => {
  it.each<[string, () => Element]>([
    [
      "Select",
      () =>
        mount(Select, {
          props: { modelValue: "a", options: [{ value: "a", label: "A" }], tip: "Fruit", keys: "F" } as never,
        }).get("button").element,
    ],
    [
      "TextField",
      () => mount(TextField, { props: { modelValue: "", tip: "Fruit", keys: "F" } as never }).get("input").element,
    ],
    [
      "NumberField",
      () => mount(NumberField, { props: { modelValue: 1, tip: "Fruit", keys: "F" } as never }).get("input").element,
    ],
    [
      "Slider",
      () => mount(Slider, { props: { modelValue: 1, tip: "Fruit", keys: "F" } as never }).get("input").element,
    ],
    ["Checkbox", () => mount(Checkbox, { props: { modelValue: false, tip: "Fruit", keys: "F" } }).get("input").element],
  ])("%s reads the tip without its key chord as its name", (_, focusable) => {
    const el = focusable();
    expect([el.getAttribute("aria-label"), el.getAttribute("aria-labelledby")]).toEqual(["Fruit", null]);
  });
});
