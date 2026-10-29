import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import UnitChip from "../../../src/components/ui/UnitChip.vue";

enableAutoUnmount(afterEach);

async function render(props: Record<string, unknown>) {
  const w = mount(UnitChip, { props: { unit: "mm", ...props }, attachTo: document.body });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return w;
}

describe("UnitChip", () => {
  it("is a plain caption without options, in the unit's own label", async () => {
    const w = await render({ unit: "deg" });
    expect([w.element.tagName, w.text(), w.classes("ui-unit-chip"), w.attributes("role")]).toEqual([
      "SPAN",
      "°",
      true,
      undefined,
    ]);
  });

  it("titles the caption only with a tip given", async () => {
    expect((await render({})).attributes("title")).toBeUndefined();
    expect((await render({ tip: "In mm" })).attributes("title")).toBe("In mm");
  });

  it("captions text that is not a measure unit as written", async () => {
    const w = await render({ unit: "%" });
    expect(w.text()).toBe("%");
  });

  it("with options is a unit picker that emits the picked unit", async () => {
    const w = await render({ options: ["mm", "in", "um"] });
    const chip = w.get(".ui-unit-chip");
    expect([chip.attributes("role"), chip.text(), chip.attributes("aria-label")]).toEqual(["combobox", "mm", "Unit"]);
    await chip.trigger("keydown", { key: "ArrowDown" });
    await flushPromises();
    const labels = [...document.body.querySelectorAll("[role=option] .opt-label")].map((e) => e.textContent);
    expect(labels).toEqual(["mm", "in", "µm"]);
    await chip.trigger("keydown", { key: "End" });
    await chip.trigger("keydown", { key: "Enter" });
    expect(w.emitted("update:unit")).toEqual([["um"]]);
  });

  it("disabled refuses to open", async () => {
    const w = await render({ options: ["mm", "in"], disabled: true });
    const chip = w.get(".ui-unit-chip");
    await chip.trigger("click");
    await chip.trigger("keydown", { key: "ArrowDown" });
    await flushPromises();
    expect([chip.attributes("aria-disabled"), document.body.querySelector("[role=listbox]")]).toEqual(["true", null]);
  });
});
