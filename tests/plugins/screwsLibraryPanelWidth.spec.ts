// The Fasteners panel stacks its form by the panel's width. Writing that from inside the ResizeObserver callback makes
// the layout change land in the same frame, which WebKit reports as a "ResizeObserver loop" window error.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import LibraryPanel from "../../plugins/FundaCAD.Screws/LibraryPanel.vue";
import { open } from "../../plugins/FundaCAD.Screws/state";
import { ENGINE } from "../../src/app/engineKey";

enableAutoUnmount(afterEach);

const observers: { fire: () => void; target: Element | null }[] = [];
let width = 900;

beforeEach(() => {
  setActivePinia(createPinia());
  observers.length = 0;
  width = 900;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private rec: (typeof observers)[number];
      constructor(cb: () => void) {
        this.rec = { fire: () => cb(), target: null };
        observers.push(this.rec);
      }
      observe(el: Element) {
        this.rec.target = el;
      }
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => width });
  open.value = true;
});
afterEach(() => {
  open.value = false;
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
});

const panel = () =>
  mount(LibraryPanel, {
    attachTo: document.body,
    global: { provide: { [ENGINE as symbol]: {} } },
  });

describe("Fasteners panel width watcher", () => {
  it("does not restack inside the ResizeObserver callback, only on the next frame", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    const w = panel();
    await flushPromises();
    const mine = observers.find((o) => o.target?.classList.contains("scr-library"));
    expect(mine).toBeDefined();
    const stacked = () => (w.vm as unknown as { stacked: boolean }).stacked;

    width = 500;
    mine!.fire();
    await flushPromises();
    expect(stacked()).toBe(false);
    frames.splice(0).forEach((cb) => cb(0));
    await flushPromises();
    expect(stacked()).toBe(true);
  });
});
