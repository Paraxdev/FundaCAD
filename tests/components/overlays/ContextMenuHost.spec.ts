// A row added to a menu that is already open must not push its last row past
// the bottom edge. happy-dom lays nothing out, so the menu's box is stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { markRaw } from "vue";
import ContextMenuHost from "../../../src/components/overlays/ContextMenuHost.vue";
import { useContextMenuStore, type CtxItem } from "../../../src/stores/contextMenu";

enableAutoUnmount(afterEach);

const ROW = 24;
const VIEW = 600;
const row = (label: string): CtxItem => ({ label, onClick: () => {} });

function menu(): HTMLElement {
  return document.body.querySelector<HTMLElement>(".context-menu")!;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("innerHeight", VIEW);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = parseFloat(this.style.top) || 0;
    const height = this.querySelectorAll(".ctx-item").length * ROW;
    return { top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ContextMenuHost", () => {
  it("moves up when an added row would run past the bottom edge", async () => {
    mount(ContextMenuHost, { attachTo: document.body });
    const s = useContextMenuStore();
    s.show(40, VIEW - 2 * ROW, [row("a"), row("b")]);
    await flushPromises();
    expect(menu().style.top).toBe(`${VIEW - 2 * ROW}px`);

    s.items = markRaw([...s.items, row("c")]);
    await flushPromises();
    expect(parseFloat(menu().style.top) + 3 * ROW).toBeLessThanOrEqual(VIEW);
  });

  it("stays put when the added row still fits", async () => {
    mount(ContextMenuHost, { attachTo: document.body });
    const s = useContextMenuStore();
    s.show(40, 100, [row("a"), row("b")]);
    await flushPromises();
    s.items = markRaw([...s.items, row("c")]);
    await flushPromises();
    expect(menu().style.top).toBe("100px");
  });
});
