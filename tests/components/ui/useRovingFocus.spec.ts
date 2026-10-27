import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h, ref, type PropType } from "vue";

import { useRovingFocus, type RovingOrientation } from "../../../src/components/ui/useRovingFocus";

enableAutoUnmount(afterEach);

type Item = { label: string; disabled?: boolean };

const Group = defineComponent({
  props: {
    items: { type: Array as PropType<Item[]>, required: true },
    active: { type: Number, default: -1 },
    orientation: { type: String as PropType<RovingOrientation>, default: "horizontal" },
    wrap: { type: Boolean, default: true },
  },
  emits: ["move"],
  setup(props, { emit }) {
    const root = ref<HTMLElement | null>(null);
    const r = useRovingFocus({
      items: () => props.items,
      active: () => props.active,
      orientation: () => props.orientation,
      wrap: () => props.wrap,
      container: root,
      onMove: (i) => emit("move", i),
    });
    return () =>
      h(
        "div",
        { ref: root, role: "radiogroup", onKeydown: r.onKeydown },
        props.items.map((it, i) =>
          h(
            "button",
            {
              type: "button",
              "data-roving": "",
              tabindex: r.tabindex(i),
              "aria-disabled": it.disabled ? "true" : undefined,
              onFocus: () => r.onFocus(i),
            },
            it.label,
          ),
        ),
      );
  },
});

const abcd = (disabled: number[] = []): Item[] =>
  ["a", "b", "c", "d"].map((label, i) => ({ label, disabled: disabled.includes(i) }));

function render(props: { items: Item[]; active?: number; orientation?: RovingOrientation; wrap?: boolean }) {
  return mount(Group, { props, attachTo: document.body });
}

const stops = (w: ReturnType<typeof render>) => w.findAll("button").map((b) => b.attributes("tabindex"));
const focused = () => (document.activeElement as HTMLElement | null)?.textContent;

function press(w: ReturnType<typeof render>, key: string, init: KeyboardEventInit = {}) {
  const target = (document.activeElement as HTMLElement | null) ?? w.element;
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

describe("useRovingFocus", () => {
  it("gives the group one Tab stop, on the active item", () => {
    expect(stops(render({ items: abcd(), active: 2 }))).toEqual(["-1", "-1", "0", "-1"]);
  });

  it("puts the stop on the first enabled item when the active one is disabled or unset", () => {
    expect(stops(render({ items: abcd([0]), active: 0 }))).toEqual(["-1", "0", "-1", "-1"]);
    expect(stops(render({ items: abcd([0, 1]) }))).toEqual(["-1", "-1", "0", "-1"]);
  });

  it("moves focus with the arrows, wraps, and moves the stop with it", async () => {
    const w = render({ items: abcd(), active: 0 });
    (w.findAll("button")[0]!.element as HTMLElement).focus();
    const seen: (string | null | undefined)[] = [];
    for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft", "ArrowLeft", "ArrowLeft"]) {
      press(w, key);
      seen.push(focused());
    }
    expect(seen).toEqual(["b", "c", "b", "a", "d"]);
    await w.vm.$nextTick();
    expect(stops(w)).toEqual(["-1", "-1", "-1", "0"]);
    expect(w.emitted("move")).toEqual([[1], [2], [1], [0], [3]]);
  });

  it("skips disabled items and goes to the ends on Home and End", () => {
    const w = render({ items: abcd([0, 2]), active: 1 });
    (w.findAll("button")[1]!.element as HTMLElement).focus();
    press(w, "ArrowRight");
    const afterRight = focused();
    press(w, "Home");
    const afterHome = focused();
    press(w, "End");
    expect([afterRight, afterHome, focused()]).toEqual(["d", "b", "d"]);
  });

  it("answers the arrows of its orientation only, and leaves modified keys alone", () => {
    const w = render({ items: abcd(), active: 0, orientation: "vertical" });
    (w.findAll("button")[0]!.element as HTMLElement).focus();
    expect([press(w, "ArrowRight"), focused()]).toEqual([false, "a"]);
    expect([press(w, "ArrowDown"), focused()]).toEqual([true, "b"]);
    expect([press(w, "ArrowDown", { ctrlKey: true }), focused()]).toEqual([false, "b"]);
  });

  it("stops at the end without wrap", () => {
    const w = render({ items: abcd(), active: 3, wrap: false });
    (w.findAll("button")[3]!.element as HTMLElement).focus();
    expect([press(w, "ArrowRight"), focused(), w.emitted("move")]).toEqual([true, "d", undefined]);
  });

  it("follows the active item when it changes from outside", async () => {
    const w = render({ items: abcd(), active: 0 });
    (w.findAll("button")[0]!.element as HTMLElement).focus();
    press(w, "ArrowRight");
    await w.setProps({ active: 3 });
    expect(stops(w)).toEqual(["-1", "-1", "-1", "0"]);
  });

  it("takes the stop to an item focused by a click", async () => {
    const w = render({ items: abcd(), active: 0 });
    (w.findAll("button")[2]!.element as HTMLElement).focus();
    await w.vm.$nextTick();
    expect(stops(w)).toEqual(["-1", "-1", "0", "-1"]);
  });
});
