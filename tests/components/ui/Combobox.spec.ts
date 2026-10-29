import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { h } from "vue";

import Combobox from "../../../src/components/ui/Combobox.vue";

enableAutoUnmount(afterEach);

type V = "fillet" | "chamfer" | "shell" | "fit";
const OPTIONS: { value: V; label: string; disabled?: boolean }[] = [
  { value: "fillet", label: "Fillet" },
  { value: "chamfer", label: "Chamfer", disabled: true },
  { value: "shell", label: "Shell" },
  { value: "fit", label: "Fit view" },
];

async function render(props: Record<string, unknown> = {}, slots: Record<string, unknown> = {}) {
  const w = mount(Combobox<V>, {
    props: {
      modelValue: "",
      options: OPTIONS,
      active: 0,
      label: "Search commands",
      "onUpdate:active": (i: number) => w.setProps({ active: i }),
      ...props,
    },
    slots: slots as never,
    attachTo: document.body,
  });
  await new Promise((r) => setTimeout(r, 2));
  return w;
}

const input = (w: Awaited<ReturnType<typeof render>>) => w.get("input");

describe("Combobox", () => {
  it("is an input with role combobox that controls a listbox named by the same label", async () => {
    const w = await render();
    const box = input(w);
    const list = w.get('[role="listbox"]');
    expect(box.attributes("role")).toBe("combobox");
    expect(box.attributes("aria-label")).toBe("Search commands");
    expect(box.attributes("aria-expanded")).toBe("true");
    expect(box.attributes("aria-autocomplete")).toBe("list");
    expect(box.attributes("aria-controls")).toBe(list.attributes("id"));
    expect(list.attributes("aria-label")).toBe("Search commands");
    const opts = w.findAll('[role="option"]');
    expect(opts.map((o) => o.attributes("id"))).toEqual(OPTIONS.map((_, i) => `${list.attributes("id")}-${i}`));
  });

  it("names the input and the list by labelledby when given it", async () => {
    const w = await render({ label: undefined, labelledby: "cmd-head" });
    expect(input(w).attributes("aria-labelledby")).toBe("cmd-head");
    expect(w.get('[role="listbox"]').attributes("aria-labelledby")).toBe("cmd-head");
  });

  it("points aria-activedescendant at the active option, which alone is aria-selected", async () => {
    const w = await render({ active: 2 });
    const opts = w.findAll('[role="option"]');
    expect(input(w).attributes("aria-activedescendant")).toBe(opts[2]!.attributes("id"));
    expect(opts.map((o) => o.attributes("aria-selected"))).toEqual(["false", "false", "true", "false"]);
  });

  it("moves the active option with ArrowDown and ArrowUp, skipping disabled ones and stopping at the ends", async () => {
    const w = await render();
    const box = input(w);
    const at = () => box.attributes("aria-activedescendant")?.split("-").pop();
    await box.trigger("keydown", { key: "ArrowDown" });
    expect(at()).toBe("2");
    await box.trigger("keydown", { key: "ArrowDown" });
    await box.trigger("keydown", { key: "ArrowDown" });
    expect(at()).toBe("3");
    await box.trigger("keydown", { key: "ArrowUp" });
    await box.trigger("keydown", { key: "ArrowUp" });
    await box.trigger("keydown", { key: "ArrowUp" });
    expect(at()).toBe("0");
    expect(w.emitted("update:active")).toEqual([[2], [3], [2], [0]]);
  });

  it("lets arrows with a modifier and other keys through to the caller untouched", async () => {
    const seen: string[] = [];
    const w = await render({ onKeydown: (e: KeyboardEvent) => seen.push(`${e.key}:${e.defaultPrevented}`) });
    await input(w).trigger("keydown", { key: "ArrowDown", ctrlKey: true });
    await input(w).trigger("keydown", { key: "Escape" });
    await input(w).trigger("keydown", { key: "ArrowDown" });
    expect(seen).toEqual(["ArrowDown:false", "Escape:false", "ArrowDown:true"]);
    expect(w.emitted("update:active")).toEqual([[2]]);
  });

  it("picks the active option on Enter and a pointer pick, never a disabled one, and keeps focus in the input", async () => {
    const w = await render();
    const box = input(w);
    (box.element as HTMLInputElement).focus();
    await box.trigger("keydown", { key: "Enter" });
    const opts = w.findAll('[role="option"]');
    await opts[3]!.trigger("mousedown");
    await opts[3]!.trigger("click");
    await opts[1]!.trigger("click");
    await w.setProps({ active: 1 });
    await box.trigger("keydown", { key: "Enter" });
    expect(w.emitted("pick")).toEqual([["fillet"], ["fit"]]);
    expect(document.activeElement).toBe(box.element);
  });

  it("with no active option Enter passes through and ArrowDown starts at the first enabled one", async () => {
    const seen: boolean[] = [];
    const w = await render({ active: -1, onKeydown: (e: KeyboardEvent) => seen.push(e.defaultPrevented) });
    expect(input(w).attributes("aria-activedescendant")).toBeUndefined();
    await input(w).trigger("keydown", { key: "Enter" });
    await input(w).trigger("keydown", { key: "ArrowDown" });
    expect(seen).toEqual([false, true]);
    expect(w.emitted("pick")).toBeUndefined();
    expect(w.emitted("update:active")).toEqual([[0]]);
  });

  it("follows the pointer over enabled options", async () => {
    const w = await render();
    await w.findAll('[role="option"]')[3]!.trigger("pointermove");
    expect(w.emitted("update:active")).toEqual([[3]]);
  });

  it("collapses when nothing matches: no listbox, aria-expanded false, the empty slot shown", async () => {
    const w = await render({ options: [], active: -1 }, { empty: () => h("p", { class: "none" }, "No match") });
    const box = input(w);
    expect(w.find('[role="listbox"]').exists()).toBe(false);
    expect(box.attributes("aria-expanded")).toBe("false");
    expect(box.attributes("aria-controls")).toBeUndefined();
    expect(box.attributes("aria-activedescendant")).toBeUndefined();
    expect(w.get(".none").text()).toBe("No match");
    await box.trigger("keydown", { key: "Enter" });
    await box.trigger("keydown", { key: "ArrowDown" });
    expect(w.emitted("pick")).toBeUndefined();
    expect(w.emitted("update:active")).toBeUndefined();
  });

  it("emits the query as v-model and draws each option through the default slot", async () => {
    const w = await render(
      { options: OPTIONS.slice(0, 1) },
      { default: (s: { option: { label: string }; active: boolean }) => h("b", `${s.option.label} ${s.active}`) },
    );
    expect(w.get('[role="option"] b').text()).toBe("Fillet true");
    await input(w).setValue("fil");
    expect(w.emitted("update:modelValue")).toEqual([["fil"]]);
  });

  it("draws the plain label when no option slot is given", async () => {
    const w = await render();
    expect(w.findAll(".opt-label").map((l) => l.text())).toEqual(OPTIONS.map((o) => o.label));
  });

  it("puts a caller class on the input well and listClass on the list wrapper", async () => {
    const w = await render({ class: "cmdk-input", listClass: "cmdk-list" });
    expect(w.get(".ui-text-field").classes()).toContain("cmdk-input");
    expect(w.find('.cmdk-list [role="listbox"]').exists()).toBe(true);
  });
});
