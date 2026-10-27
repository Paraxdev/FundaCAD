import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import Select from "../../../src/components/ui/Select.vue";
import { escapeClaimed } from "../../../src/ui/escapeClaim";

enableAutoUnmount(afterEach);

type V = "apple" | "banana" | "blueberry" | "cherry" | "date";
const OPTIONS: { value: V; label: string; disabled?: boolean }[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "blueberry", label: "Blueberry", disabled: true },
  { value: "cherry", label: "Cherry" },
  { value: "date", label: "Date" },
];

async function render(props: Record<string, unknown> = {}) {
  const w = mount(Select<V>, {
    props: { modelValue: "banana", options: OPTIONS, ...props },
    attachTo: document.body,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  const trigger = w.get("button");
  (trigger.element as HTMLElement).focus();
  return { w, trigger, el: trigger.element as HTMLElement };
}

const listbox = () => document.body.querySelector<HTMLElement>("[role=listbox]");
const options = () => [...document.body.querySelectorAll<HTMLElement>("[role=option]")];
const activeLabel = (el: HTMLElement) => {
  const id = el.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.querySelector(".opt-label")?.textContent : null;
};
const picked = (w: Awaited<ReturnType<typeof render>>["w"]) => w.emitted<[V]>("update:modelValue") ?? [];

async function key(trigger: Awaited<ReturnType<typeof render>>["trigger"], k: string, init: KeyboardEventInit = {}) {
  await trigger.trigger("keydown", { key: k, ...init });
  await flushPromises();
}

describe("Select", () => {
  it("is a closed combobox that names its value", async () => {
    const { el } = await render();
    expect([
      el.getAttribute("role"),
      el.getAttribute("aria-haspopup"),
      el.getAttribute("aria-expanded"),
      el.getAttribute("aria-activedescendant"),
      el.textContent?.trim(),
      listbox(),
    ]).toEqual(["combobox", "listbox", "false", null, "Banana", null]);
  });

  it("opens on ArrowDown with the selected option active and the listbox wired up", async () => {
    const { trigger, el } = await render();
    await key(trigger, "ArrowDown");
    const list = listbox()!;
    expect([el.getAttribute("aria-expanded"), el.getAttribute("aria-controls"), activeLabel(el)]).toEqual([
      "true",
      list.id,
      "Banana",
    ]);
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false", "false"]);
    expect(document.activeElement).toBe(el);
  });

  it("opens on ArrowUp too, and on Alt+ArrowDown", async () => {
    const a = await render();
    await key(a.trigger, "ArrowUp");
    expect(a.el.getAttribute("aria-expanded")).toBe("true");
    a.w.unmount();
    const b = await render();
    await key(b.trigger, "ArrowDown", { altKey: true });
    expect(b.el.getAttribute("aria-expanded")).toBe("true");
  });

  it("moves with the arrows, skips disabled options, stops at the ends, and jumps with Home and End", async () => {
    const { trigger, el } = await render();
    await key(trigger, "ArrowDown");
    await key(trigger, "ArrowDown");
    expect(activeLabel(el)).toBe("Cherry");
    await key(trigger, "ArrowDown");
    await key(trigger, "ArrowDown");
    expect(activeLabel(el)).toBe("Date");
    await key(trigger, "ArrowUp");
    await key(trigger, "ArrowUp");
    expect(activeLabel(el)).toBe("Banana");
    await key(trigger, "Home");
    expect(activeLabel(el)).toBe("Apple");
    await key(trigger, "End");
    expect(activeLabel(el)).toBe("Date");
    expect(options().map((o) => o.classList.contains("is-active"))).toEqual([false, false, false, false, true]);
  });

  it("picks the active option on Enter, closes, and keeps focus on the trigger", async () => {
    const { w, trigger, el } = await render();
    await key(trigger, "ArrowDown");
    await key(trigger, "ArrowDown");
    await key(trigger, "Enter");
    expect(picked(w)).toEqual([["cherry"]]);
    expect([el.getAttribute("aria-expanded"), listbox(), document.activeElement]).toEqual(["false", null, el]);
  });

  it("picks on Space as well, and emits nothing when the pick is the current value", async () => {
    const { w, trigger } = await render();
    await key(trigger, "ArrowDown");
    await key(trigger, " ");
    expect([picked(w), listbox()]).toEqual([[], null]);
  });

  it("closes on Escape without picking, claims that Escape, and returns focus to the trigger", async () => {
    const { w, trigger, el } = await render();
    await key(trigger, "ArrowDown");
    expect(escapeClaimed()).toBe(true);
    await key(trigger, "ArrowDown");
    // A pointer pick moves focus into the list; Escape from there must still land back on the trigger.
    options()[0]!.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect([picked(w), el.getAttribute("aria-expanded"), listbox(), document.activeElement]).toEqual([
      [],
      "false",
      null,
      el,
    ]);
  });

  it("closes on Tab without picking", async () => {
    const { w, trigger } = await render();
    await key(trigger, "ArrowDown");
    await key(trigger, "ArrowDown");
    await key(trigger, "Tab");
    expect([picked(w), listbox()]).toEqual([[], null]);
  });

  it("types ahead by label, opening the list, cycling on a repeated letter and skipping disabled options", async () => {
    const { w, trigger, el } = await render({ modelValue: "apple" });
    await key(trigger, "c");
    expect([el.getAttribute("aria-expanded"), activeLabel(el)]).toEqual(["true", "Cherry"]);
    await new Promise((r) => setTimeout(r, 600));
    await key(trigger, "b");
    expect(activeLabel(el)).toBe("Banana");
    await key(trigger, "b");
    expect(activeLabel(el)).toBe("Banana");
    await new Promise((r) => setTimeout(r, 600));
    await key(trigger, "d");
    await key(trigger, "Enter");
    expect(picked(w)).toEqual([["date"]]);
  });

  it("types a word ahead, not only its first letter", async () => {
    const { trigger, el } = await render({
      modelValue: "apple",
      options: [
        { value: "apple", label: "Apple" },
        { value: "banana", label: "Bandsaw" },
        { value: "blueberry", label: "Banana" },
      ],
    });
    for (const k of "bana") await key(trigger, k);
    expect(activeLabel(el)).toBe("Banana");
  });

  it("opens on click and picks a clicked option", async () => {
    const { w, trigger } = await render();
    await trigger.trigger("click");
    await flushPromises();
    expect(listbox()).not.toBeNull();
    options()[3]!.click();
    await flushPromises();
    expect([picked(w), listbox()]).toEqual([[["cherry"]], null]);
  });

  it("opens on a click that lands in the same millisecond as its mount", async () => {
    const w = mount(Select<V>, { props: { modelValue: "banana", options: OPTIONS }, attachTo: document.body });
    (w.get("button").element as HTMLElement).click();
    await flushPromises();
    expect(listbox()).not.toBeNull();
  });

  it("refuses a click on a disabled option", async () => {
    const { w, trigger } = await render();
    await trigger.trigger("click");
    await flushPromises();
    options()[2]!.click();
    await flushPromises();
    expect(picked(w)).toEqual([]);
    expect(options()[2]!.getAttribute("aria-disabled")).toBe("true");
  });

  it("disabled: aria-disabled with its title kept, and neither a click nor a key opens it", async () => {
    const { trigger, el } = await render({ disabled: true, disabledReason: "Wait for the run to finish" });
    expect([el.getAttribute("aria-disabled"), el.classList.contains("is-disabled"), el.getAttribute("title")]).toEqual([
      "true",
      true,
      "Wait for the run to finish",
    ]);
    el.click();
    await key(trigger, "ArrowDown");
    await key(trigger, "a");
    expect(listbox()).toBeNull();
  });

  it("shows the placeholder when no option holds the value", async () => {
    const { el } = await render({ modelValue: "fig", placeholder: "Pick a fruit" });
    expect(el.textContent?.trim()).toBe("Pick a fruit");
  });

  it("keeps the attributes callers and e2e scripts rely on", async () => {
    const { el } = await render({ id: "fruit", testid: "fruit-pick", size: "sm", tip: "Fruit" });
    expect([
      el.id,
      el.dataset.testid,
      el.dataset.value,
      el.classList.contains("select-trigger"),
      el.classList.contains("ui-select-sm"),
      el.getAttribute("title"),
      el.getAttribute("type"),
    ]).toEqual(["fruit", "fruit-pick", "banana", true, true, "Fruit", "button"]);
  });
});
