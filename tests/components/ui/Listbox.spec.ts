import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { h, nextTick } from "vue";

import Listbox from "../../../src/components/ui/Listbox.vue";

enableAutoUnmount(afterEach);

type V = "oak" | "steel" | "glass" | "brass" | "slate" | "rubber" | "stone";
// In a three column grid: oak steel glass / brass slate rubber / stone.
const ITEMS: { value: V; label: string; disabled?: boolean }[] = [
  { value: "oak", label: "Oak" },
  { value: "steel", label: "Steel" },
  { value: "glass", label: "Glass" },
  { value: "brass", label: "Brass" },
  { value: "slate", label: "Slate", disabled: true },
  { value: "rubber", label: "Rubber" },
  { value: "stone", label: "Stone" },
];

type Wrapper = ReturnType<typeof mount>;

// jsdom lays nothing out, so each option's row is stubbed the way a grid of `cols` columns would place it.
function layout(w: Wrapper, cols: number) {
  w.findAll('[role="option"]').forEach((o, i) =>
    Object.defineProperty(o.element, "offsetTop", { configurable: true, get: () => Math.floor(i / cols) * 40 }),
  );
}

function render(props: Record<string, unknown> = {}, cols = 3, onTileClick?: (e: MouseEvent) => void) {
  const w: Wrapper = mount(Listbox<V>, {
    props: {
      items: ITEMS,
      modelValue: null,
      label: "Materials",
      "onUpdate:modelValue": (v: V) => w.setProps({ modelValue: v }),
      ...props,
    },
    slots: {
      option: (p: { item: { label: string }; attrs: object }) =>
        h("button", { type: "button", class: "tile", ...p.attrs, onClick: onTileClick }, p.item.label),
    },
    attachTo: document.body,
  });
  layout(w, cols);
  return w;
}

const opts = (w: Wrapper) => w.findAll('[role="option"]');
const focusedLabel = () => document.activeElement?.textContent;

function key(el: Element, k: string, init: KeyboardEventInit = {}, type = "keydown") {
  const e = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

async function press(k: string, init: KeyboardEventInit = {}) {
  const e = key(document.activeElement!, k, init);
  await nextTick();
  return e;
}

describe("Listbox", () => {
  it("is a named listbox of options, with one Tab stop on the first enabled option when nothing is selected", () => {
    const w = render();
    const list = w.get('[role="listbox"]');
    expect(list.attributes("aria-label")).toBe("Materials");
    expect(opts(w).map((o) => o.attributes("tabindex"))).toEqual(["0", "-1", "-1", "-1", "-1", "-1", "-1"]);
    expect(opts(w).map((o) => o.attributes("aria-selected"))).toEqual(Array(7).fill("false"));
    expect(opts(w)[4]!.attributes("aria-disabled")).toBe("true");
    expect(opts(w)[0]!.attributes("aria-disabled")).toBeUndefined();
    const ids = opts(w).map((o) => o.attributes("id"));
    expect(new Set(ids).size).toBe(7);
  });

  it("names the list by labelledby when given it", () => {
    const w = render({ label: undefined, labelledby: "lib-head" });
    expect(w.get('[role="listbox"]').attributes("aria-labelledby")).toBe("lib-head");
  });

  it("puts the Tab stop and aria-selected on the selected option", () => {
    const w = render({ modelValue: "glass" });
    expect(opts(w).map((o) => o.attributes("tabindex"))).toEqual(["-1", "-1", "0", "-1", "-1", "-1", "-1"]);
    expect(opts(w)[2]!.attributes("aria-selected")).toBe("true");
  });

  it("moves focus in the grid with the arrows, skipping disabled options and stopping at the edges", async () => {
    const w = render();
    (opts(w)[0]!.element as HTMLElement).focus();
    await press("ArrowLeft");
    expect(focusedLabel()).toBe("Oak");
    await press("ArrowRight");
    expect(focusedLabel()).toBe("Steel");
    await press("ArrowDown");
    // Slate below Steel is disabled and nothing lies below it, so focus stays.
    expect(focusedLabel()).toBe("Steel");
    await press("ArrowLeft");
    await press("ArrowDown");
    expect(focusedLabel()).toBe("Brass");
    await press("ArrowRight");
    expect(focusedLabel()).toBe("Rubber");
    await press("ArrowUp");
    expect(focusedLabel()).toBe("Glass");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(focusedLabel()).toBe("Rubber");
    await press("ArrowLeft");
    expect(focusedLabel()).toBe("Brass");
    await press("ArrowDown");
    expect(focusedLabel()).toBe("Stone");
    const last = await press("ArrowRight");
    expect(focusedLabel()).toBe("Stone");
    expect(last.defaultPrevented).toBe(true);
  });

  it("moves the Tab stop with focus without selecting anything", async () => {
    const w = render();
    (opts(w)[0]!.element as HTMLElement).focus();
    await press("ArrowRight");
    expect(opts(w).map((o) => o.attributes("tabindex"))).toEqual(["-1", "0", "-1", "-1", "-1", "-1", "-1"]);
    expect(w.emitted("update:modelValue")).toBeUndefined();
    expect(w.emitted("apply")).toBeUndefined();
  });

  it("steps one option at a time with Up and Down in a single column", async () => {
    const w = render({}, 1);
    (opts(w)[0]!.element as HTMLElement).focus();
    await press("ArrowDown");
    expect(focusedLabel()).toBe("Steel");
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(focusedLabel()).toBe("Rubber");
    await press("ArrowUp");
    expect(focusedLabel()).toBe("Brass");
  });

  it("goes to the first and the last enabled option with Home and End", async () => {
    const w = render({ items: [{ value: "slate", label: "Slate", disabled: true }, ...ITEMS.slice(0, 4)] });
    (opts(w)[2]!.element as HTMLElement).focus();
    await press("Home");
    expect(focusedLabel()).toBe("Oak");
    await press("End");
    expect(focusedLabel()).toBe("Brass");
  });

  it("moves focus to the option a typed letter or word starts, skipping disabled ones", async () => {
    vi.useFakeTimers();
    try {
      const w = render();
      (opts(w)[0]!.element as HTMLElement).focus();
      await press("S", { shiftKey: true });
      expect(focusedLabel()).toBe("Steel");
      await press("t");
      await press("o");
      expect(focusedLabel()).toBe("Stone");
      vi.advanceTimersByTime(600);
      await press("b");
      expect(focusedLabel()).toBe("Brass");
      vi.advanceTimersByTime(600);
      await press("s");
      expect(focusedLabel()).toBe("Stone");
      await press("s");
      expect(focusedLabel()).toBe("Steel");
      vi.advanceTimersByTime(600);
      await press("g");
      expect(focusedLabel()).toBe("Glass");
      expect(w.emitted("update:modelValue")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects the focused option with Space and swallows the Space keyup a button would click on", async () => {
    const w = render();
    (opts(w)[0]!.element as HTMLElement).focus();
    await press("ArrowRight");
    const down = await press(" ");
    expect(down.defaultPrevented).toBe(true);
    expect(w.emitted("update:modelValue")).toEqual([["steel"]]);
    expect(opts(w)[1]!.attributes("aria-selected")).toBe("true");
    expect(key(document.activeElement!, " ", {}, "keyup").defaultPrevented).toBe(true);
    expect(key(document.activeElement!, " ", {}, "keyup").defaultPrevented).toBe(false);
    await press(" ");
    expect(w.emitted("update:modelValue")).toHaveLength(1);
  });

  it("emits apply for the focused option on Enter and keeps the button from clicking", async () => {
    const w = render({ modelValue: "oak" });
    (opts(w)[0]!.element as HTMLElement).focus();
    await press("ArrowRight");
    const e = await press("Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(w.emitted("apply")).toEqual([["steel"]]);
    expect(w.emitted("update:modelValue")).toBeUndefined();
  });

  it("selects a clicked option, not a disabled one, and leaves a click the caller handled alone", async () => {
    const w = render();
    await opts(w)[2]!.trigger("click");
    expect(w.emitted("update:modelValue")).toEqual([["glass"]]);
    await opts(w)[4]!.trigger("click");
    expect(w.emitted("update:modelValue")).toHaveLength(1);

    const own = render({}, 3, (e) => e.preventDefault());
    await opts(own)[1]!.trigger("click");
    expect(own.emitted("update:modelValue")).toBeUndefined();
  });

  it("takes the Tab stop to an option focused by a click", async () => {
    const w = render();
    (opts(w)[5]!.element as HTMLElement).focus();
    await nextTick();
    expect(opts(w)[5]!.attributes("tabindex")).toBe("0");
    expect(opts(w)[0]!.attributes("tabindex")).toBe("-1");
  });

  it("leaves keys with Ctrl, Alt or Meta and keys the caller already handled alone", async () => {
    const w = render();
    (opts(w)[0]!.element as HTMLElement).focus();
    for (const mod of ["ctrlKey", "altKey", "metaKey"]) {
      const e = await press("ArrowRight", { [mod]: true });
      expect(e.defaultPrevented).toBe(false);
      expect(focusedLabel()).toBe("Oak");
    }
    const handled = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    handled.preventDefault();
    document.activeElement!.dispatchEvent(handled);
    await nextTick();
    expect(focusedLabel()).toBe("Oak");
    expect((await press("Tab")).defaultPrevented).toBe(false);
  });
});
