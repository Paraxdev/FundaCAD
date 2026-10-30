import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, ref, type Component, type PropType } from "vue";

import Toolbar from "../../../src/components/ui/Toolbar.vue";
import type { RovingOrientation } from "../../../src/components/ui/useRovingFocus";

enableAutoUnmount(afterEach);

type Part =
  | string
  | {
      text?: string;
      disabled?: boolean;
      soft?: boolean;
      gone?: boolean;
      field?: boolean;
      radios?: string[];
      card?: boolean;
    };

const Host = defineComponent({
  props: {
    parts: { type: Array as PropType<Part[]>, required: true },
    orientation: { type: String as PropType<RovingOrientation>, default: "horizontal" },
    wrap: { type: Boolean, default: true },
  },
  setup(props, { expose }) {
    const bar = ref<{ focus: () => void } | null>(null);
    expose({ focusBar: () => bar.value?.focus() });
    const part = (p: Part) => {
      if (typeof p === "string") return h("button", { type: "button", key: p }, p);
      if (p.card)
        return h("div", { role: "dialog", key: "card", "aria-label": "Card" }, [h("button", { tabindex: 0 }, "in")]);
      if (p.gone)
        return h("div", { key: p.text ?? "", style: { display: "none" } }, [h("button", { type: "button" }, p.text)]);
      if (p.field) return h("input", { type: "text", key: "field", "aria-label": "Field" });
      if (p.radios)
        return h(
          "div",
          {
            role: "radiogroup",
            key: "radios",
            "aria-label": "Mode",
            onKeydown: (e: KeyboardEvent) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.preventDefault();
            },
          },
          p.radios.map((r, i) => h("button", { type: "button", role: "radio", tabindex: i === 1 ? 0 : -1 }, r)),
        );
      return h(
        "button",
        { type: "button", key: p.text ?? "", disabled: p.disabled, "aria-disabled": p.soft ? "true" : undefined },
        p.text,
      );
    };
    return () =>
      h(
        Toolbar as Component,
        {
          ref: (el: unknown) => (bar.value = el as typeof bar.value),
          label: "Tools",
          orientation: props.orientation,
          wrap: props.wrap,
        },
        { default: () => props.parts.map(part) },
      );
  },
});

function render(parts: Part[], o: { orientation?: RovingOrientation; wrap?: boolean } = {}) {
  return mount(Host, { props: { parts, ...o }, attachTo: document.body });
}

const stops = (w: ReturnType<typeof render>) =>
  w.findAll("button, input").map((b) => `${b.text() || b.attributes("aria-label")}:${b.attributes("tabindex")}`);
const focused = () => {
  const el = document.activeElement as HTMLElement | null;
  return el?.textContent || el?.getAttribute("aria-label");
};
const focusOn = (w: ReturnType<typeof render>, text: string) =>
  (w.findAll("button").find((b) => b.text() === text)!.element as HTMLElement).focus();

function press(key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e.defaultPrevented;
}

describe("Toolbar", () => {
  it("is a named toolbar that says its orientation only when vertical", () => {
    const flat = render(["a"]);
    expect(flat.get("[role=toolbar]").attributes()).toMatchObject({ "aria-label": "Tools" });
    expect(flat.get("[role=toolbar]").attributes("aria-orientation")).toBeUndefined();
    const tall = render(["a"], { orientation: "vertical" });
    expect(tall.get("[role=toolbar]").attributes("aria-orientation")).toBe("vertical");
  });

  it("gives its buttons one Tab stop, on the first", () => {
    expect(stops(render(["a", "b", "c"]))).toEqual(["a:0", "b:-1", "c:-1"]);
  });

  it("moves focus and the stop with the arrows of its orientation, Home and End, wrapping", () => {
    const w = render(["a", "b", "c"]);
    focusOn(w, "a");
    const seen: unknown[] = [];
    for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft", "Home", "End"]) {
      press(key);
      seen.push(focused());
    }
    expect(seen).toEqual(["b", "c", "a", "c", "a", "c"]);
    expect(stops(w)).toEqual(["a:-1", "b:-1", "c:0"]);
    expect([press("ArrowDown"), focused()]).toEqual([false, "c"]);
    expect([press("ArrowLeft", { ctrlKey: true }), focused()]).toEqual([false, "c"]);
  });

  it("answers Up and Down when vertical and stops at the end without wrap", () => {
    const w = render(["a", "b"], { orientation: "vertical", wrap: false });
    focusOn(w, "a");
    expect([press("ArrowRight"), focused()]).toEqual([false, "a"]);
    expect([press("ArrowDown"), focused()]).toEqual([true, "b"]);
    expect([press("ArrowDown"), focused()]).toEqual([true, "b"]);
  });

  it("skips a natively disabled button and keeps an aria-disabled one reachable", () => {
    const w = render(["a", { text: "off", disabled: true }, { text: "soft", soft: true }]);
    expect(stops(w)).toEqual(["a:0", "off:undefined", "soft:-1"]);
    focusOn(w, "a");
    press("ArrowRight");
    expect(focused()).toBe("soft");
  });

  it("arrows onto a nested radiogroup's own stop and leaves its keys and tabindex to it", () => {
    const w = render(["a", { radios: ["x", "y"] }, "b"]);
    expect(stops(w)).toEqual(["a:0", "x:-1", "y:0", "b:-1"]);
    focusOn(w, "a");
    press("ArrowRight");
    expect(focused()).toBe("y");
    expect([press("ArrowRight"), focused()]).toEqual([true, "y"]);
    press("End");
    expect(focused()).toBe("b");
    press("ArrowLeft");
    expect(focused()).toBe("y");
    expect(stops(w)).toEqual(["a:-1", "x:-1", "y:0", "b:-1"]);
  });

  it("skips an item that is not shown and anything inside an inline dialog", () => {
    const w = render(["a", { text: "gone", gone: true }, { card: true }, "b"]);
    focusOn(w, "a");
    press("ArrowRight");
    expect(focused()).toBe("b");
    expect(stops(w)).toEqual(["a:-1", "gone:undefined", "in:0", "b:0"]);
  });

  it("leaves the arrows to a text field", () => {
    const w = render(["a", { field: true }, "b"]);
    (w.get("input").element as HTMLElement).focus();
    expect([press("ArrowRight"), focused()]).toEqual([false, "Field"]);
    expect(stops(w)).toEqual(["a:-1", "Field:0", "b:-1"]);
  });

  it("takes the stop to an item focused by a click or from outside", () => {
    const w = render(["a", "b", "c"]);
    focusOn(w, "b");
    expect(stops(w)).toEqual(["a:-1", "b:0", "c:-1"]);
  });

  it("gives an item added later tabindex -1 and keeps the stop when another item goes", async () => {
    const w = render(["a", "b", "c"]);
    focusOn(w, "c");
    await w.setProps({ parts: ["b", "c", "d"] });
    await flushPromises();
    expect(stops(w)).toEqual(["b:-1", "c:0", "d:-1"]);
  });

  it("moves the stop to the first item when the item holding it goes", async () => {
    const w = render(["a", "b", "c"]);
    focusOn(w, "c");
    await w.setProps({ parts: ["a", "b"] });
    await flushPromises();
    expect(stops(w)).toEqual(["a:0", "b:-1"]);
  });

  it("focuses the item holding the stop through its exposed focus", () => {
    const w = render(["a", "b", "c"]);
    focusOn(w, "b");
    (document.activeElement as HTMLElement).blur();
    (w.vm as unknown as { focusBar: () => void }).focusBar();
    expect(focused()).toBe("b");
  });
});
