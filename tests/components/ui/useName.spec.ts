import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";

import { useName, type NameProps } from "../../../src/components/ui/useName";

enableAutoUnmount(afterEach);

const Probe = defineComponent({
  inheritAttrs: false,
  props: { label: String, labelledby: String, slotted: Boolean },
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
});
