import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import SwitchRow from "../../../src/components/ui/SwitchRow.vue";
import Toggle from "../../../src/components/ui/Toggle.vue";

enableAutoUnmount(afterEach);

type Props = {
  modelValue: boolean;
  label: string;
  icon?: string;
  layout?: "float" | "param";
  disabled?: boolean;
  disabledReason?: string;
};

async function render(props: Props, opts: { attrs?: Record<string, unknown>; slots?: Record<string, string> } = {}) {
  const w = mount(SwitchRow, {
    props: { ...props, "onUpdate:modelValue": (v: boolean) => w.setProps({ modelValue: v }) },
    attachTo: document.body,
    ...opts,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return w;
}

const emitted = (w: Awaited<ReturnType<typeof render>>) => w.emitted<[boolean]>("update:modelValue") ?? [];

describe("SwitchRow", () => {
  it("is a label row holding the switch, with the state shown and the attrs on the row", async () => {
    const w = await render(
      { modelValue: false, label: "Show overlays" },
      { attrs: { "data-overlay": "all", title: "All overlays" } },
    );
    expect(w.element.tagName).toBe("LABEL");
    expect([w.attributes("data-overlay"), w.attributes("title")]).toEqual(["all", "All overlays"]);
    expect(w.find(".ui-switch-row-label").text()).toBe("Show overlays");
    expect(w.find(".ui-switch-row-state").text()).toBe("Off");
    const sw = w.find('[role="switch"]');
    expect([sw.attributes("aria-checked"), sw.attributes("aria-label")]).toEqual(["false", "Show overlays"]);
    await w.setProps({ modelValue: true });
    expect([w.find(".ui-switch-row-state").text(), sw.attributes("aria-checked")]).toEqual(["On", "true"]);
  });

  it("flips once for a click on the label text and once for a click on the switch", async () => {
    const w = await render({ modelValue: false, label: "Grid" });
    await w.find(".ui-switch-row-label").trigger("click");
    expect(emitted(w)).toEqual([[true]]);
    await w.find('[role="switch"]').trigger("click");
    expect(emitted(w)).toEqual([[true], [false]]);
    await w.find(".ui-switch-row-state").trigger("click");
    expect(emitted(w)).toEqual([[true], [false], [true]]);
  });

  it("flips on Space on the switch", async () => {
    const w = await render({ modelValue: true, label: "Grid" });
    w.find('[role="switch"]').element.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
    );
    await flushPromises();
    expect(emitted(w)).toEqual([[false]]);
    expect(w.find('[role="switch"]').attributes("aria-checked")).toBe("false");
  });

  it("refuses the label, the switch and Space while disabled, and shows the reason", async () => {
    const w = await render({ modelValue: false, label: "Edges", disabled: true, disabledReason: "Turn overlays on" });
    expect([w.classes("is-disabled"), w.attributes("title")]).toEqual([true, "Turn overlays on"]);
    const sw = w.find('[role="switch"]');
    expect([sw.attributes("aria-disabled"), sw.attributes("disabled")]).toEqual(["true", undefined]);
    await w.find(".ui-switch-row-label").trigger("click");
    await sw.trigger("click");
    sw.element.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(emitted(w)).toEqual([]);
  });

  it("drops the state text in the param layout and renders the hint slot", async () => {
    const w = await render({ modelValue: false, label: "Reverse", layout: "param" }, { slots: { hint: "Flips it" } });
    expect(w.classes()).toContain("ui-switch-row-param");
    expect(w.find(".ui-switch-row-state").exists()).toBe(false);
    expect(w.find(".ui-switch-row-hint").text()).toBe("Flips it");
  });

  it("keeps ui/Toggle.vue as the same component and the e2e classes on it", async () => {
    expect(Toggle).toBe(SwitchRow);
    const w = await render({ modelValue: true, label: "Grid" });
    expect([w.classes("float-toggle"), w.find(".ft-switch").exists()]).toEqual([true, true]);
  });
});
