import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import Switch from "../../../src/components/ui/Switch.vue";
import { setMacForTest } from "../../../src/input/platform";

enableAutoUnmount(afterEach);
afterEach(() => setMacForTest(null));

type Props = {
  modelValue: boolean;
  label?: string;
  tip?: string;
  keys?: string;
  disabled?: boolean;
  disabledReason?: string;
};

async function render(props: Props) {
  const w = mount(Switch, {
    props: { ...props, "onUpdate:modelValue": (v: boolean) => w.setProps({ modelValue: v }) },
    attachTo: document.body,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return w;
}

function press(el: Element, key: string, init: KeyboardEventInit = {}, type = "keydown") {
  const e = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}

const emitted = (w: Awaited<ReturnType<typeof render>>) => w.emitted<[boolean]>("update:modelValue") ?? [];

describe("Switch", () => {
  it("is a button with role switch whose aria-checked follows the value", async () => {
    const w = await render({ modelValue: false, label: "Grid" });
    expect([w.element.tagName, w.attributes("type"), w.attributes("role"), w.attributes("aria-label")]).toEqual([
      "BUTTON",
      "button",
      "switch",
      "Grid",
    ]);
    expect([w.attributes("aria-checked"), w.classes("is-on")]).toEqual(["false", false]);
    await w.setProps({ modelValue: true });
    expect([w.attributes("aria-checked"), w.classes("is-on")]).toEqual(["true", true]);
  });

  it("flips on click", async () => {
    const w = await render({ modelValue: false, label: "Grid" });
    await w.trigger("click");
    await w.trigger("click");
    expect(emitted(w)).toEqual([[true], [false]]);
  });

  it("flips on Space and on Enter, claims both keys and ignores a held key", async () => {
    const w = await render({ modelValue: false, label: "Grid" });
    expect(press(w.element, " ")).toBe(true);
    expect(press(w.element, " ", {}, "keyup")).toBe(true);
    await flushPromises();
    expect(press(w.element, "Enter")).toBe(true);
    expect(press(w.element, "Enter", { repeat: true })).toBe(true);
    expect(press(w.element, "a")).toBe(false);
    expect(emitted(w)).toEqual([[true], [false]]);
  });

  it("refuses click, Space and Enter while disabled, without the native attribute, and keeps the reason as title", async () => {
    const w = await render({ modelValue: false, label: "Grid", disabled: true, disabledReason: "Turn overlays on" });
    expect([w.attributes("aria-disabled"), w.attributes("disabled"), w.classes("is-disabled")]).toEqual([
      "true",
      undefined,
      true,
    ]);
    expect(w.attributes("title")).toBe("Turn overlays on");
    await w.trigger("click");
    press(w.element, " ");
    press(w.element, "Enter");
    expect(emitted(w)).toEqual([]);
  });

  it("writes the tip and its keys through fmtKeys into title and aria-label", async () => {
    setMacForTest(true);
    const w = await render({ modelValue: false, tip: "Snap", keys: "Ctrl+G" });
    expect([w.attributes("title"), w.attributes("aria-label")]).toEqual(["Snap (⌘+G)", "Snap (⌘+G)"]);
  });
});
