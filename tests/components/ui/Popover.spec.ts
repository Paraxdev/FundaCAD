import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";

import Popover from "../../../src/components/ui/Popover.vue";
import Select from "../../../src/components/ui/Select.vue";
import Menu from "../../../src/components/ui/Menu.vue";
import MenuItem from "../../../src/components/ui/MenuItem.vue";
import { escapeClaimed } from "../../../src/ui/escapeClaim";
import { setInputModalityForTest } from "../../../src/ui/inputModality";

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

async function render(
  props: Record<string, unknown> = {},
  focusOpener = true,
  openerAttrs: Record<string, string> = {},
) {
  const open = ref(false);
  const Host = defineComponent({
    setup() {
      const opener = ref<HTMLButtonElement | null>(null);
      return () => [
        h("button", { ref: opener, class: "opener", ...openerAttrs }, "Pick"),
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
  if (focusOpener) $(".opener")!.focus();
  open.value = true;
  await nextTick();
  await settle();
  return { open };
}

describe("Popover", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setInputModalityForTest("pointer");
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

  describe("named", () => {
    it("is a dialog named by its label or by the element labelledby points at", async () => {
      await render({ label: "Views" });
      expect([$(".float-popover")!.getAttribute("role"), $(".float-popover")!.getAttribute("aria-label")]).toEqual([
        "dialog",
        "Views",
      ]);
      document.body.innerHTML = "";
      await render({ labelledby: "pick-head" });
      const card = $(".float-popover")!;
      expect([
        card.getAttribute("role"),
        card.getAttribute("aria-labelledby"),
        card.hasAttribute("aria-label"),
      ]).toEqual(["dialog", "pick-head", false]);
    });

    it("opened by a key, focuses its first control and gives focus back to the opener on Escape", async () => {
      setInputModalityForTest("keyboard");
      const { open } = await render({ label: "Pick" });
      expect(active()?.className).toBe("a");
      esc();
      await nextTick();
      expect([open.value, active()?.className]).toEqual([false, "opener"]);
    });

    it("opened by a click, leaves focus alone, and a press outside does not pull focus to the opener", async () => {
      const { open } = await render({ label: "Pick" }, false);
      expect(active()).toBe(document.body);
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await nextTick();
      expect([open.value, active()]).toEqual([false, document.body]);
    });

    it("opened by a click, gives focus back when the user tabbed into it", async () => {
      const { open } = await render({ label: "Pick" });
      $(".b")!.focus();
      esc();
      await nextTick();
      expect([open.value, active()?.className]).toEqual([false, "opener"]);
    });

    it("keeps an explicit focus none and returnFocus false", async () => {
      setInputModalityForTest("keyboard");
      const { open } = await render({ label: "Pick", focus: "none", returnFocus: false });
      expect(active()?.className).toBe("opener");
      $(".a")!.focus();
      esc();
      await nextTick();
      expect(open.value).toBe(false);
      expect(active()?.className).not.toBe("opener");
    });
  });

  describe("name check", () => {
    const named = (warn: { mock: { calls: unknown[][] } }) =>
      warn.mock.calls.filter((c) => String(c[0]).includes("Popover has no name")).length;

    it("warns in a dev build when it has neither a name nor role none", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await render();
      expect(named(warn)).toBe(1);
      expect($(".float-popover")!.hasAttribute("role")).toBe(false);
      warn.mockRestore();
    });

    it("role none needs no name and is no dialog, a named card does not warn", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await render({ role: "none" });
      expect($(".float-popover")!.hasAttribute("role")).toBe(false);
      document.body.innerHTML = "";
      await render({ label: "Pick" });
      expect(named(warn)).toBe(0);
      warn.mockRestore();
    });

    it("a card opened from a combobox or a listbox popup is part of its opener and needs no name", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await render({}, true, { role: "combobox" });
      document.body.innerHTML = "";
      await render({}, true, { "aria-haspopup": "listbox" });
      expect(named(warn)).toBe(0);
      expect($(".float-popover")!.hasAttribute("role")).toBe(false);
      document.body.innerHTML = "";
      await render({}, true, { "aria-haspopup": "dialog" });
      expect(named(warn)).toBe(1);
      warn.mockRestore();
    });

    it("a card opened from a tree or grid popup still asks for a name or role none", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await render({}, true, { "aria-haspopup": "tree" });
      document.body.innerHTML = "";
      await render({}, true, { "aria-haspopup": "grid" });
      document.body.innerHTML = "";
      await render({ role: "none" }, true, { "aria-haspopup": "tree" });
      expect(named(warn)).toBe(2);
      warn.mockRestore();
    });

    it("an open Select's list card does not warn", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const options = [
        { value: "a", label: "Apple" },
        { value: "b", label: "Banana" },
      ];
      const w = mount(Select<string>, { props: { modelValue: "a", options, label: "Fruit" }, attachTo: document.body });
      await w.get("button").trigger("click");
      await settle();
      expect([!!$("[role=listbox]"), named(warn)]).toEqual([true, 0]);
      warn.mockRestore();
    });
  });
});
