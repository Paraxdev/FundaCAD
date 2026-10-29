import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import Checkbox from "../../../src/components/ui/Checkbox.vue";

enableAutoUnmount(afterEach);

type Props = {
  modelValue: boolean;
  label?: string;
  labelledby?: string;
  indeterminate?: boolean;
  tip?: string;
  disabled?: boolean;
  disabledReason?: string;
};

async function render(props: Props, { follow = true, attrs = {} as Record<string, string> } = {}) {
  const w = mount(Checkbox, {
    props: {
      ...props,
      "onUpdate:modelValue": (v: boolean) => (follow ? w.setProps({ modelValue: v }) : undefined),
    } as never,
    attrs,
    attachTo: document.body,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return w;
}

const input = (w: Awaited<ReturnType<typeof render>>) => w.find("input").element as HTMLInputElement;
const emitted = (w: Awaited<ReturnType<typeof render>>) => w.emitted<[boolean]>("update:modelValue") ?? [];

function press(el: Element, key: string, type = "keydown") {
  const e = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}

describe("Checkbox", () => {
  it("lays a native checkbox under the drawn box, inside a label", async () => {
    const w = await render({ modelValue: true, label: "Snap to grid" });
    expect(w.element.tagName).toBe("LABEL");
    expect([input(w).type, input(w).checked]).toEqual(["checkbox", true]);
    expect(w.find(".ui-checkbox-box .ui-checkbox-mark").exists()).toBe(true);
    expect(w.find(".ui-checkbox-label").text()).toBe("Snap to grid");
  });

  it("toggles once for a click on the label and once for a click on the box", async () => {
    const w = await render({ modelValue: false, label: "Snap" });
    await w.find(".ui-checkbox-label").trigger("click");
    expect([emitted(w), input(w).checked]).toEqual([[[true]], true]);
    await w.find("input").trigger("click");
    expect([emitted(w), input(w).checked]).toEqual([[[true], [false]], false]);
  });

  it("toggles on Space and claims the key so the native toggle does not add a second flip", async () => {
    const w = await render({ modelValue: false, label: "Snap" });
    expect(press(input(w), " ")).toBe(true);
    expect(press(input(w), " ", "keyup")).toBe(true);
    await flushPromises();
    expect([emitted(w), input(w).checked]).toEqual([[[true]], true]);
  });

  it("stays at its value when the parent does not take the change", async () => {
    const w = await render({ modelValue: false, label: "Snap" }, { follow: false });
    await w.find("input").trigger("click");
    expect([emitted(w), input(w).checked]).toEqual([[[true]], false]);
  });

  it("shows indeterminate, and Space from it turns the box on", async () => {
    const w = await render({ modelValue: false, label: "All", indeterminate: true });
    expect([input(w).indeterminate, w.classes("is-mixed")]).toEqual([true, true]);
    press(input(w), " ");
    expect(emitted(w)).toEqual([[true]]);
  });

  it("turns on from indeterminate for a click as for Space, whatever the value under it", async () => {
    const w = await render({ modelValue: true, label: "All", indeterminate: true }, { follow: false });
    await w.find("input").trigger("click");
    press(input(w), " ");
    expect([emitted(w), input(w).checked, input(w).indeterminate]).toEqual([[[true], [true]], true, true]);
  });

  it("is named by its drawn label or slot through the wrapping label, with no aria name on the box", async () => {
    const drawn = await render({ modelValue: false, label: "Snap to grid" });
    const slotted = mount(Checkbox, { props: { modelValue: false }, slots: { default: "<b>Orbit inertia</b>" } });
    for (const w of [drawn, slotted]) {
      const box = w.get("input");
      expect([box.attributes("aria-label"), box.attributes("aria-labelledby")]).toEqual([undefined, undefined]);
    }
    expect(slotted.get(".ui-checkbox-label").text()).toBe("Orbit inertia");
  });

  it("puts labelledby or a plugin's aria-label on the box, not on the label, and keeps tip as the tooltip only", async () => {
    const by = await render({ modelValue: false, labelledby: "row-title", tip: "Run it" });
    expect([input(by).getAttribute("aria-labelledby"), input(by).getAttribute("aria-label")]).toEqual([
      "row-title",
      null,
    ]);
    expect([by.attributes("title"), by.find(".ui-checkbox-label").exists()]).toEqual(["Run it", false]);
    const plug = await render({ modelValue: false }, { attrs: { "aria-label": "Select all", id: "all" } });
    expect([input(plug).getAttribute("aria-label"), plug.attributes("aria-label"), plug.attributes("id")]).toEqual([
      "Select all",
      undefined,
      "all",
    ]);
  });

  it("warns in a dev build when it has no label, labelledby or slot, and not when the slot names it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const named = () => warn.mock.calls.filter((c) => String(c[0]).includes("Checkbox has no name")).length;
    mount(Checkbox, { props: { modelValue: false }, slots: { default: "Orbit inertia" } });
    expect(named()).toBe(0);
    mount(Checkbox, { props: { modelValue: false, tip: "Only a tooltip" } });
    expect(named()).toBe(1);
    warn.mockRestore();
  });

  it("refuses the label, the box and Space while disabled, keeps focus and the reason as title", async () => {
    const w = await render({ modelValue: false, label: "Snap", disabled: true, disabledReason: "Open a sketch" });
    expect([input(w).getAttribute("aria-disabled"), input(w).disabled, w.classes("is-disabled")]).toEqual([
      "true",
      false,
      true,
    ]);
    expect(w.attributes("title")).toBe("Open a sketch");
    await w.find(".ui-checkbox-label").trigger("click");
    await w.find("input").trigger("click");
    press(input(w), " ");
    expect([emitted(w), input(w).checked]).toEqual([[], false]);
  });
});
