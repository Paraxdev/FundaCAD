import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";

import Menu from "../../../src/components/ui/Menu.vue";
import MenuItem from "../../../src/components/ui/MenuItem.vue";
import MenuSeparator from "../../../src/components/ui/MenuSeparator.vue";
import { escapeClaimed } from "../../../src/ui/escapeClaim";
import Dialog from "../../../src/components/ui/Dialog.vue";
import { createPinia, setActivePinia } from "pinia";

enableAutoUnmount(afterEach);

// Vue skips a listener for an event stamped in the same millisecond it was attached, and the claim releases a task
// after the unmount, so the unmount is flushed before the timer starts.
const settle = async () => {
  await flushPromises();
  await new Promise((r) => setTimeout(r, 5));
};

function key(k: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}
const focused = () => document.activeElement?.querySelector(".ui-menu-label")?.textContent ?? null;
const menus = () => [...document.querySelectorAll<HTMLElement>(".ui-menu")];

async function render(extra: { checked?: boolean } = {}) {
  const picked = vi.fn();
  const open = ref(false);
  const Host = defineComponent({
    setup() {
      const opener = ref<HTMLButtonElement | null>(null);
      return () => [
        h("button", { ref: opener, class: "opener" }, "File"),
        open.value
          ? h(Menu, { anchor: opener.value, label: "File", onClose: () => (open.value = false) }, () => [
              h(MenuItem, { label: "New", keys: "Ctrl+N", onSelect: () => picked("new") }),
              h(MenuItem, { label: "Open", disabled: true, onSelect: () => picked("open") }),
              h(MenuSeparator),
              h(MenuItem, { label: "Save", onSelect: () => picked("save") }),
              h(MenuItem, { label: "Export" }, () => [
                h(MenuItem, { label: "STL", onSelect: () => picked("stl") }),
                h(MenuItem, { label: "STEP", onSelect: () => picked("step") }),
              ]),
              h(MenuItem, { label: "Settings", checked: extra.checked, onSelect: () => picked("settings") }),
            ])
          : null,
      ];
    },
  });
  const w = mount(Host, { attachTo: document.body });
  (w.find(".opener").element as HTMLElement).focus();
  open.value = true;
  await nextTick();
  await settle();
  return { w, open, picked };
}

describe("Menu", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a menu of menuitems and a separator, and focuses the first enabled item", async () => {
    await render();
    const [menu] = menus();
    expect(menu!.getAttribute("role")).toBe("menu");
    expect(menu!.getAttribute("aria-label")).toBe("File");
    const rows = [...menu!.children].map((el) => [el.getAttribute("role"), el.textContent?.trim()]);
    expect(rows.map((r) => r[0])).toEqual(["menuitem", "menuitem", "separator", "menuitem", "menuitem", "menuitem"]);
    expect(focused()).toBe("New");
    const open = menu!.children[1] as HTMLElement;
    expect([open.getAttribute("aria-disabled"), open.classList.contains("is-disabled")]).toEqual(["true", true]);
    const exp = menu!.children[4] as HTMLElement;
    expect([exp.getAttribute("aria-haspopup"), exp.getAttribute("aria-expanded")]).toEqual(["menu", "false"]);
    expect((menu!.children[0] as HTMLElement).getAttribute("aria-keyshortcuts")).toBe("Ctrl+N");
  });

  it("moves with ArrowDown and ArrowUp, skipping the disabled item and wrapping, and Home and End", async () => {
    await render();
    const seen: (string | null)[] = [];
    for (const k of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "Home", "End"]) {
      key(k);
      seen.push(focused());
    }
    expect(seen).toEqual(["Save", "Export", "Settings", "New", "Save", "New", "New", "Settings"]);
  });

  it("type ahead jumps to the next item starting with the typed letters", async () => {
    await render();
    key("s");
    expect(focused()).toBe("Save");
    key("s");
    expect(focused()).toBe("Settings");
    await new Promise((r) => setTimeout(r, 600));
    key("e");
    key("x");
    expect(focused()).toBe("Export");
  });

  it("ArrowRight opens the submenu on its first item, ArrowLeft closes it back to the parent", async () => {
    await render();
    key("End");
    key("ArrowUp");
    expect(focused()).toBe("Export");
    key("ArrowRight");
    await nextTick();
    await settle();
    expect(menus().length).toBe(2);
    expect(focused()).toBe("STL");
    expect(document.querySelector('[aria-haspopup="menu"]')!.getAttribute("aria-expanded")).toBe("true");
    key("ArrowDown");
    expect(focused()).toBe("STEP");
    key("ArrowLeft");
    await nextTick();
    expect(menus().length).toBe(1);
    expect(focused()).toBe("Export");
  });

  it("Enter activates the focused item and closes the menu, focus returns to the opener", async () => {
    const { picked, open } = await render();
    key("ArrowDown");
    key("Enter");
    await nextTick();
    expect(picked.mock.calls).toEqual([["save"]]);
    expect(open.value).toBe(false);
    expect(menus()).toEqual([]);
    expect((document.activeElement as HTMLElement).className).toBe("opener");
  });

  it("an item in a submenu activates and closes the whole tree", async () => {
    const { picked, open } = await render();
    key("End");
    key("ArrowUp");
    key("ArrowRight");
    await nextTick();
    await settle();
    key(" ");
    await nextTick();
    expect([picked.mock.calls, open.value, menus().length]).toEqual([[["stl"]], false, 0]);
    expect((document.activeElement as HTMLElement).className).toBe("opener");
  });

  it("a click activates, and a disabled item refuses both click and Enter", async () => {
    const { picked, open } = await render();
    const [menu] = menus();
    const disabled = menu!.children[1] as HTMLElement;
    disabled.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    disabled.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect([picked.mock.calls, open.value]).toEqual([[], true]);
    (menu!.children[3] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect([picked.mock.calls, open.value]).toEqual([[["save"]], false]);
  });

  it("Escape closes the topmost menu only, claims Escape while open, and returns focus", async () => {
    const { open } = await render();
    const outer = vi.fn((e: KeyboardEvent) => e.key);
    window.addEventListener("keydown", outer);
    try {
      expect(escapeClaimed()).toBe(true);
      key("End");
      key("ArrowUp");
      key("ArrowRight");
      await nextTick();
      await settle();
      expect(menus().length).toBe(2);
      key("Escape");
      await nextTick();
      expect([menus().length, open.value, focused()]).toEqual([1, true, "Export"]);
      expect(escapeClaimed()).toBe(true);
      key("Escape");
      await nextTick();
      expect([menus().length, open.value]).toEqual([0, false]);
      expect((document.activeElement as HTMLElement).className).toBe("opener");
      expect(escapeClaimed()).toBe(true);
      await settle();
      expect(escapeClaimed()).toBe(false);
      expect(outer.mock.results.map((r) => r.value)).not.toContain("Escape");
    } finally {
      window.removeEventListener("keydown", outer);
    }
  });

  it("a press outside the menu closes it, a press inside does not", async () => {
    const { open } = await render();
    menus()[0]!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(open.value).toBe(true);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(open.value).toBe(false);
  });

  it("checked items are menuitemcheckbox with aria-checked, and every row keeps the check gutter", async () => {
    await render({ checked: true });
    const [menu] = menus();
    const settings = [...menu!.children].at(-1) as HTMLElement;
    expect([settings.getAttribute("role"), settings.getAttribute("aria-checked")]).toEqual([
      "menuitemcheckbox",
      "true",
    ]);
    expect(menu!.querySelectorAll(".ui-menu-check").length).toBe(5);
  });

  it("hears Escape as soon as it is mounted", async () => {
    const closes = vi.fn();
    mount(Menu, {
      attachTo: document.body,
      props: { onClose: closes },
      slots: { default: () => h(MenuItem, { label: "Only" }) },
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(closes).toHaveBeenCalledTimes(1);
  });

  it("an item that opens a dialog hands it the opener, so closing the dialog focuses the opener", async () => {
    setActivePinia(createPinia());
    const open = ref(false);
    const dialog = ref(false);
    // Mounted first, so its update runs before the menu's and the dialog mounts while the menu is still open.
    const DialogHost = defineComponent({
      setup: () => () =>
        dialog.value ? h(Dialog, { title: "Export", onClose: () => (dialog.value = false) }, () => h("input")) : null,
    });
    const MenuHost = defineComponent({
      setup() {
        const opener = ref<HTMLButtonElement | null>(null);
        return () => [
          h("button", { ref: opener, class: "opener" }, "File"),
          open.value
            ? h(Menu, { anchor: opener.value, onClose: () => (open.value = false) }, () => [
                h(MenuItem, { label: "Export", onSelect: () => (dialog.value = true) }),
              ])
            : null,
        ];
      },
    });
    mount(defineComponent({ setup: () => () => [h(DialogHost), h(MenuHost)] }), { attachTo: document.body });
    (document.querySelector(".opener") as HTMLElement).focus();
    open.value = true;
    await nextTick();
    await settle();
    key("Enter");
    await nextTick();
    await settle();
    expect([menus().length, document.activeElement?.tagName]).toEqual([0, "INPUT"]);
    dialog.value = false;
    await nextTick();
    expect(document.activeElement?.className).toBe("opener");
  });

  it("opens at a point when given at", async () => {
    const open = ref(true);
    mount(
      defineComponent({
        setup: () => () =>
          open.value ? h(Menu, { at: { x: 40, y: 60 } }, () => [h(MenuItem, { label: "Only" })]) : null,
      }),
      { attachTo: document.body },
    );
    await nextTick();
    await settle();
    const [menu] = menus();
    expect([menu!.style.left, menu!.style.top]).toEqual(["40px", "60px"]);
  });
});
