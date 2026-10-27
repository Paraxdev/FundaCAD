import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import Checkbox from "../../../src/components/ui/Checkbox.vue";

enableAutoUnmount(afterEach);

type Props = {
  modelValue: boolean;
  label?: string;
  indeterminate?: boolean;
  tip?: string;
  disabled?: boolean;
  disabledReason?: string;
};

async function render(props: Props, { follow = true } = {}) {
  const w = mount(Checkbox, {
    props: { ...props, "onUpdate:modelValue": (v: boolean) => (follow ? w.setProps({ modelValue: v }) : undefined) },
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

  it("names a box with no label from its tip", async () => {
    const w = await render({ modelValue: false, tip: "Select all" });
    expect([input(w).getAttribute("aria-label"), w.attributes("title")]).toEqual(["Select all", "Select all"]);
    expect(w.find(".ui-checkbox-label").exists()).toBe(false);
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
