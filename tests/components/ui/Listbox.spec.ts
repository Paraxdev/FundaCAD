import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { h, nextTick } from "vue";

import Listbox from "../../../src/components/ui/Listbox.vue";
import { setMacForTest } from "../../../src/input/platform";

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
      "onUpdate:modelValue": (v: V | V[]) => w.setProps({ modelValue: v }),
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

  // The window keymap turns the view on the arrows and starts tools on letters, and it does not read defaultPrevented.
  it("keeps the keys it handles from the window's shortcuts and lets the others through", async () => {
    const w = render({ multiple: true, modelValue: [] });
    const heard: string[] = [];
    const listen = (e: KeyboardEvent) => heard.push(e.key);
    window.addEventListener("keydown", listen);
    try {
      (opts(w)[0]!.element as HTMLElement).focus();
      for (const k of ["ArrowRight", "ArrowDown", "Home", "End", "r", " ", "Enter"]) await press(k);
      await press("a", { ctrlKey: true });
      await press("ArrowLeft", { shiftKey: true });
      expect(heard).toEqual([]);
      for (const k of ["Delete", "Escape", "Tab", "F2"]) await press(k);
      await press("z", { ctrlKey: true });
      expect(heard).toEqual(["Delete", "Escape", "Tab", "F2", "z"]);
    } finally {
      window.removeEventListener("keydown", listen);
    }
  });

  it("hands the slot the caller's own item, extra fields and all", () => {
    const items = ITEMS.map((it) => ({ ...it, swatch: `#${it.value}` }));
    const w = mount(Listbox<V, (typeof items)[number]>, {
      props: { items, modelValue: null, label: "Materials" },
      slots: {
        option: (p: { item: (typeof items)[number]; attrs: object }) => h("button", { ...p.attrs }, p.item.swatch),
      },
    });
    expect(opts(w).map((o) => o.text())).toEqual(ITEMS.map((it) => `#${it.value}`));
  });
});

describe("Listbox multiple", () => {
  afterEach(() => setMacForTest(null));

  const multi = (props: Record<string, unknown> = {}) => render({ multiple: true, modelValue: [], ...props });
  const picks = (w: Wrapper) => w.emitted("update:modelValue")?.map((e) => e[0]);
  const selected = (w: Wrapper) => opts(w).map((o) => o.attributes("aria-selected") === "true");

  it("is multiselectable, marks every picked option and puts the Tab stop on the first one", () => {
    const w = multi({ modelValue: ["rubber", "glass"] });
    expect(w.get('[role="listbox"]').attributes("aria-multiselectable")).toBe("true");
    expect(selected(w)).toEqual([false, false, true, false, false, true, false]);
    expect(opts(w).map((o) => o.attributes("tabindex"))).toEqual(["-1", "-1", "0", "-1", "-1", "-1", "-1"]);
    expect(render().get('[role="listbox"]').attributes("aria-multiselectable")).toBeUndefined();
  });

  it("toggles the focused option with Space and keeps the others picked", async () => {
    const w = multi({ modelValue: ["oak"] });
    (opts(w)[0]!.element as HTMLElement).focus();
    await press("ArrowRight");
    expect(picks(w)).toBeUndefined();
    expect((await press(" ")).defaultPrevented).toBe(true);
    expect(selected(w)).toEqual([true, true, false, false, false, false, false]);
    await press(" ");
    expect(picks(w)).toEqual([["oak", "steel"], ["oak"]]);
  });

  it("extends the run from the anchor with Shift and an arrow, growing and shrinking it", async () => {
    const w = multi();
    (opts(w)[0]!.element as HTMLElement).focus();
    await press(" ");
    await press("ArrowRight", { shiftKey: true });
    expect(focusedLabel()).toBe("Steel");
    await press("ArrowRight", { shiftKey: true });
    await press("ArrowDown", { shiftKey: true });
    expect(focusedLabel()).toBe("Rubber");
    // The run passes Slate, which is disabled, so it stays out.
    expect(selected(w)).toEqual([true, true, true, true, false, true, false]);
    await press("ArrowUp", { shiftKey: true });
    expect(selected(w)).toEqual([true, true, true, false, false, false, false]);
    await press("Home", { shiftKey: true });
    expect(selected(w)).toEqual([true, false, false, false, false, false, false]);
    const n = picks(w)!.length;
    expect((await press("ArrowLeft", { shiftKey: true })).defaultPrevented).toBe(true);
    expect(picks(w)).toHaveLength(n);
  });

  it("anchors a Shift run on the focused option when nothing anchors it yet", async () => {
    const w = multi();
    (opts(w)[1]!.element as HTMLElement).focus();
    await press("ArrowRight", { shiftKey: true });
    expect(picks(w)).toEqual([["steel", "glass"]]);
  });

  it("takes the run from the anchor to the focused option with Shift and Space", async () => {
    const w = multi();
    (opts(w)[0]!.element as HTMLElement).focus();
    await press(" ");
    await press("ArrowRight");
    await press("ArrowRight");
    await press(" ", { shiftKey: true });
    expect(selected(w)).toEqual([true, true, true, false, false, false, false]);
  });

  it("reports the anchor and follows one the caller sets", async () => {
    const w = multi({ anchor: "glass" });
    (opts(w)[0]!.element as HTMLElement).focus();
    await press("ArrowRight", { shiftKey: true });
    expect(picks(w)).toEqual([["steel", "glass"]]);
    await press("ArrowLeft");
    await press(" ");
    expect(w.emitted("update:anchor")).toEqual([["oak"]]);
  });

  it("selects every enabled option with Cmd+A on macOS and Ctrl+A elsewhere", async () => {
    const all = ["oak", "steel", "glass", "brass", "rubber", "stone"];
    for (const mac of [true, false]) {
      setMacForTest(mac);
      const w = multi();
      (opts(w)[0]!.element as HTMLElement).focus();
      const other = await press("a", mac ? { ctrlKey: true } : { metaKey: true });
      expect(other.defaultPrevented).toBe(false);
      expect(picks(w)).toBeUndefined();
      const mod = await press("a", mac ? { metaKey: true } : { ctrlKey: true });
      expect(mod.defaultPrevented).toBe(true);
      expect(picks(w)).toEqual([all]);
      expect(focusedLabel()).toBe("Oak");
    }
    setMacForTest(false);
    const single = render();
    (opts(single)[0]!.element as HTMLElement).focus();
    expect((await press("a", { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(single.emitted("update:modelValue")).toBeUndefined();
  });

  it("still emits apply for the focused option on Enter, leaving the picks alone", async () => {
    const w = multi({ modelValue: ["oak"] });
    (opts(w)[0]!.element as HTMLElement).focus();
    await press("ArrowRight");
    await press("Enter");
    expect(w.emitted("apply")).toEqual([["steel"]]);
    expect(picks(w)).toBeUndefined();
  });

  it("takes a plain click alone, a Ctrl or Cmd click as a toggle and a Shift click as a run", async () => {
    const w = multi({ modelValue: ["oak"] });
    await opts(w)[1]!.trigger("click");
    await opts(w)[2]!.trigger("click", { ctrlKey: true });
    await opts(w)[3]!.trigger("click", { metaKey: true });
    await opts(w)[3]!.trigger("click", { metaKey: true });
    await opts(w)[5]!.trigger("click", { shiftKey: true });
    await opts(w)[4]!.trigger("click", { ctrlKey: true });
    expect(picks(w)).toEqual([
      ["steel"],
      ["steel", "glass"],
      ["steel", "glass", "brass"],
      ["steel", "glass"],
      ["brass", "rubber"],
    ]);
  });

  it("keeps the picks when a Shift arrow meets the edge", async () => {
    const w = multi();
    (opts(w)[2]!.element as HTMLElement).focus();
    await press(" ");
    await press("Home");
    await press(" ");
    await press("ArrowLeft", { shiftKey: true });
    expect(picks(w)).toEqual([["glass"], ["glass", "oak"]]);
  });

  it("anchors on the focused option when the anchor it was given is not in the list", async () => {
    const w = multi({ items: ITEMS.slice(0, 3), anchor: "stone" });
    (opts(w)[0]!.element as HTMLElement).focus();
    await press("ArrowRight", { shiftKey: true });
    expect(w.emitted("update:anchor")).toEqual([["oak"]]);
    expect(picks(w)).toEqual([["oak", "steel"]]);
  });

  it("emits nothing when a key or click leaves the picks as they were", async () => {
    setMacForTest(false);
    const w = multi({ modelValue: ["steel"] });
    await opts(w)[1]!.trigger("click");
    (opts(w)[0]!.element as HTMLElement).focus();
    await press("a", { ctrlKey: true });
    await press("a", { ctrlKey: true });
    expect(picks(w)).toHaveLength(1);
    expect((await press("a", { ctrlKey: true, shiftKey: true })).defaultPrevented).toBe(false);
  });

  it("keeps a disabled option or one from outside the list that the caller picked", async () => {
    setMacForTest(false);
    const w = multi({ modelValue: ["slate"] });
    await opts(w)[0]!.trigger("click", { ctrlKey: true });
    expect(picks(w)).toEqual([["slate", "oak"]]);
    const shared = multi({ items: ITEMS.slice(0, 3), modelValue: ["stone"] });
    (opts(shared)[0]!.element as HTMLElement).focus();
    await press("a", { ctrlKey: true });
    expect(picks(shared)).toEqual([["oak", "steel", "glass", "stone"]]);
  });
});
