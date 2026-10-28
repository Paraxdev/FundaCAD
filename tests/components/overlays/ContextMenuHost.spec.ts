// happy-dom lays nothing out, so the menu's size is stubbed from its row count.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { markRaw } from "vue";
import ContextMenuHost from "../../../src/components/overlays/ContextMenuHost.vue";
import { useContextMenuStore, type CtxItem } from "../../../src/stores/contextMenu";
import { escapeClaimed } from "../../../src/ui/escapeClaim";

enableAutoUnmount(afterEach);

const ROW = 24;
const VIEW = 600;
const row = (label: string, extra: Partial<CtxItem> = {}): CtxItem => ({ label, onClick: () => {}, ...extra });

const menus = () => [...document.body.querySelectorAll<HTMLElement>(".ui-menu")];
const menu = () => document.body.querySelector<HTMLElement>(".ui-menu:not(.ui-submenu)")!;
const focused = () => document.activeElement?.querySelector(".ui-menu-label")?.textContent ?? null;

// The claim on Escape is released a task after the close.
const settle = () => new Promise((r) => setTimeout(r, 5));

function key(k: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

async function open(items: CtxItem[], x = 40, y = 100) {
  mount(ContextMenuHost, { attachTo: document.body });
  const s = useContextMenuStore();
  s.show(x, y, items);
  await flushPromises();
  return s;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("innerHeight", VIEW);
  vi.stubGlobal("innerWidth", 1000);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("ui-menu") ? this.querySelectorAll(".ctx-item").length * ROW : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ContextMenuHost placement", () => {
  it("moves up when an added row would run past the bottom edge", async () => {
    const s = await open([row("a"), row("b")], 40, VIEW - 2 * ROW - 4);
    expect(menu().style.top).toBe(`${VIEW - 2 * ROW - 4}px`);

    s.items = markRaw([...s.items, row("c")]);
    await flushPromises();
    expect(parseFloat(menu().style.top) + 3 * ROW).toBeLessThanOrEqual(VIEW);
  });

  it("stays put when the added row still fits", async () => {
    const s = await open([row("a"), row("b")]);
    s.items = markRaw([...s.items, row("c")]);
    await flushPromises();
    expect(menu().style.top).toBe("100px");
  });
});

describe("ContextMenuHost keyboard", () => {
  it("rows are focusable menu items, the first takes focus and arrows skip a disabled row", async () => {
    await open([row("Rename"), row("Hide", { disabled: true }), { separator: true, label: "" }, row("Delete")]);
    const rows = [...menu().querySelectorAll<HTMLElement>(".ctx-item")];
    expect(rows.map((r) => r.getAttribute("role"))).toEqual(["menuitem", "menuitem", "menuitem"]);
    expect(focused()).toBe("Rename");
    key("ArrowDown");
    expect(focused()).toBe("Delete");
    key("r");
    expect(focused()).toBe("Rename");
  });

  it("Enter runs the row and closes the menu", async () => {
    const onClick = vi.fn();
    const s = await open([row("Rename", { onClick }), row("Delete")]);
    key("Enter");
    await flushPromises();
    expect(onClick).toHaveBeenCalledOnce();
    expect([s.open, menus().length]).toEqual([false, 0]);
  });

  it("ArrowRight opens a row's children and ArrowLeft goes back, Enter there runs the child", async () => {
    const hide = vi.fn();
    const s = await open([row("Visibility", { children: [row("Show all"), row("Hide these 4", { onClick: hide })] })]);
    key("ArrowRight");
    await flushPromises();
    expect([menus().length, focused()]).toEqual([2, "Show all"]);
    key("ArrowLeft");
    await flushPromises();
    expect([menus().length, focused()]).toEqual([1, "Visibility"]);
    key("ArrowRight");
    await flushPromises();
    key("ArrowDown");
    key("Enter");
    await flushPromises();
    expect([hide.mock.calls.length, s.open]).toEqual([1, false]);
  });

  it("Escape closes only the topmost menu and never reaches a tool listening on the window", async () => {
    const tool = vi.fn();
    window.addEventListener("keydown", tool);
    try {
      const s = await open([row("Visibility", { children: [row("Show all")] })]);
      expect(escapeClaimed()).toBe(true);
      key("ArrowRight");
      await flushPromises();
      key("Escape");
      await flushPromises();
      expect([menus().length, s.open, focused()]).toEqual([1, true, "Visibility"]);
      key("Escape");
      await settle();
      expect([menus().length, s.open, escapeClaimed()]).toEqual([0, false, false]);
      expect(tool).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", tool);
    }
  });

  it("keeps the keys it moves and types ahead with from the window's shortcuts", async () => {
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    try {
      await open([row("Rename"), row("Delete")]);
      key("ArrowDown");
      key("x");
      key("Delete");
      expect(shortcut.mock.calls.map(([e]) => (e as KeyboardEvent).key)).toEqual(["Delete"]);
    } finally {
      window.removeEventListener("keydown", shortcut);
    }
  });

  it("a menu opened over a text field leaves focus in the field", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    await open([row("Cut"), row("Paste")]);
    expect(document.activeElement).toBe(field);
  });
});
