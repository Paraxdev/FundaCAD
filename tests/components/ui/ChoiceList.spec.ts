import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import ChoiceList from "../../../src/components/ui/ChoiceList.vue";

enableAutoUnmount(afterEach);

type V = "a" | "b" | "c" | "d";
const OPTIONS: { value: V; label: string; disabled?: boolean; clickable?: boolean }[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", disabled: true },
  { value: "c", label: "Gamma" },
  { value: "d", label: "Delta" },
];

async function render(props: Record<string, unknown> = {}) {
  const w = mount(ChoiceList<V>, {
    props: { options: OPTIONS, modelValue: "c", label: "Fruit", ...props },
    attachTo: document.body,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return { w, rows: w.findAll(".opt-row") };
}

describe("ChoiceList", () => {
  it("is a listbox of options with the value selected", async () => {
    const { w, rows } = await render();
    expect(w.attributes("role")).toBe("listbox");
    expect(rows.map((r) => [r.attributes("role"), r.attributes("aria-selected")])).toEqual([
      ["option", "false"],
      ["option", "false"],
      ["option", "true"],
      ["option", "false"],
    ]);
    expect(rows.map((r) => r.classes("is-selected"))).toEqual([false, false, true, false]);
  });

  it("standalone it holds one Tab stop on the value and moves focus with the arrows, skipping disabled rows", async () => {
    const { rows } = await render();
    expect(rows.map((r) => r.attributes("tabindex"))).toEqual(["-1", "-1", "0", "-1"]);
    (rows[2]!.element as HTMLElement).focus();
    await rows[2]!.trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]!.element);
    await rows[0]!.trigger("keydown", { key: "End" });
    expect(document.activeElement).toBe(rows[3]!.element);
  });

  it("emits a click on an enabled row, refuses a disabled one, and answers a clickable greyed one", async () => {
    const { w, rows } = await render({
      options: [...OPTIONS.slice(0, 3), { value: "d", label: "Delta", disabled: true, clickable: true }],
    });
    await rows[1]!.trigger("click");
    await rows[0]!.trigger("click");
    await rows[3]!.trigger("click");
    expect(w.emitted("update:modelValue")).toEqual([["a"], ["d"]]);
  });

  it("driven by a combobox it takes no focus, marks the active row and names each option", async () => {
    const { w, rows } = await render({ active: 3, id: "fruit-list" });
    expect(w.attributes("id")).toBe("fruit-list");
    expect(rows.map((r) => [r.attributes("tabindex"), r.classes("is-active"), r.attributes("id")])).toEqual([
      ["-1", false, "fruit-list-0"],
      ["-1", false, "fruit-list-1"],
      ["-1", false, "fruit-list-2"],
      ["-1", true, "fruit-list-3"],
    ]);
    await rows[0]!.trigger("pointermove");
    expect(w.emitted("update:active")).toEqual([[0]]);
  });

  it("names the listbox by its label, or by labelledby alone", async () => {
    const { w } = await render();
    expect([w.attributes("aria-label"), w.attributes("aria-labelledby")]).toEqual(["Fruit", undefined]);
    const by = (await render({ label: undefined, labelledby: "fruit-head" })).w;
    expect([by.attributes("aria-label"), by.attributes("aria-labelledby")]).toEqual([undefined, "fruit-head"]);
  });

  it("warns in a dev build when it has no name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount(ChoiceList<V>, { props: { options: OPTIONS, modelValue: "c" } as never });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("ChoiceList has no name"))).toBe(true);
    warn.mockRestore();
  });
});
