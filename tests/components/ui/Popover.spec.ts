import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";

import Popover from "../../../src/components/ui/Popover.vue";
import Menu from "../../../src/components/ui/Menu.vue";
import MenuItem from "../../../src/components/ui/MenuItem.vue";
import { escapeClaimed } from "../../../src/ui/escapeClaim";

enableAutoUnmount(afterEach);

// The claim on Escape is released a task after the popover unmounts, so the unmount is flushed before the timer starts.
const settle = async () => {
  await flushPromises();
  await new Promise((r) => setTimeout(r, 5));
};
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const active = () => document.activeElement as HTMLElement | null;

function esc(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  (active() ?? document.body).dispatchEvent(e);
  return e;
}

async function render(props: Record<string, unknown> = {}) {
  const open = ref(false);
  const Host = defineComponent({
    setup() {
      const opener = ref<HTMLButtonElement | null>(null);
      return () => [
        h("button", { ref: opener, class: "opener" }, "Pick"),
        open.value
          ? h(Popover, { anchor: opener.value, ...props, onClose: () => (open.value = false) }, () => [
              h("p", "Pick one"),
              h("button", { class: "a" }, "A"),
              h("button", { class: "b" }, "B"),
            ])
          : null,
      ];
    },
  });
  mount(Host, { attachTo: document.body });
  $(".opener")!.focus();
  open.value = true;
  await nextTick();
  await settle();
  return { open };
}

describe("Popover", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("leaves focus where it was by default, and Escape closes it without returning focus", async () => {
    const { open } = await render();
    expect(active()?.className).toBe("opener");
    $(".a")!.focus();
    esc();
    await nextTick();
    expect(open.value).toBe(false);
    expect(active()?.className).not.toBe("opener");
  });

  it("focus first moves focus to its first control, returnFocus gives it back to the opener on close", async () => {
    const { open } = await render({ focus: "first", returnFocus: true });
    expect(active()?.className).toBe("a");
    esc();
    await nextTick();
    expect(open.value).toBe(false);
    expect(active()?.className).toBe("opener");
  });

  it("focuses the card itself when it holds no control", async () => {
    const open = ref(true);
    mount(
      defineComponent({
        setup: () => () =>
          open.value ? h(Popover, { anchor: document.body, focus: "first" }, () => h("p", "Note")) : null,
      }),
      { attachTo: document.body },
    );
    await nextTick();
    await settle();
    expect(active()?.classList.contains("float-popover")).toBe(true);
  });

  it("Escape closes only the menu opened from inside it, then the popover, claimed all along", async () => {
    const { open } = await render({ focus: "first" });
    const menuOpen = ref(true);
    mount(
      defineComponent({
        setup: () => () =>
          menuOpen.value
            ? h(Menu, { anchor: $(".a"), onClose: () => (menuOpen.value = false) }, () => h(MenuItem, { label: "X" }))
            : null,
      }),
      { attachTo: document.body },
    );
    await nextTick();
    await settle();
    esc();
    await nextTick();
    expect([menuOpen.value, open.value, escapeClaimed()]).toEqual([false, true, true]);
    esc();
    await nextTick();
    expect(open.value).toBe(false);
  });

  it("hears Escape as soon as it is mounted", async () => {
    const closes = vi.fn();
    mount(Popover, {
      attachTo: document.body,
      props: { anchor: null, onClose: closes },
      slots: { default: () => h("p", "Hi") },
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(closes).toHaveBeenCalledTimes(1);
  });

  it("a press inside a menu opened from it does not close it", async () => {
    const { open } = await render();
    mount(Menu, { props: { at: { x: 0, y: 0 } }, slots: { default: () => h(MenuItem, { label: "X" }) } });
    await nextTick();
    $(".ui-menu-item")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(open.value).toBe(true);
  });
});
