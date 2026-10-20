// While Home is up the title bar behind it is switched off, all but the Home
// button. jsdom does not implement inert, so this checks the attribute is where
// it has to be, e2e/home_e2e.cjs proves a click and Tab really skip the bar.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import type { HomeCallbacks } from "../../../src/ui/home";
import { useHomeStore } from "../../../src/stores/home";
import TitleBar from "../../../src/components/shell/TitleBar.vue";

vi.mock("../../../src/app/menubarDef", () => ({
  buildMenubar: () => [{ label: "File", items: [{ label: "Home", onClick: () => {} }] }],
}));

enableAutoUnmount(afterEach);

function makeEngine() {
  const live = { snapshot: { sharing: false, guests: [] }, subscribe: () => () => {} };
  return { live, ui: { home: { toggle: vi.fn() } }, doUndo: vi.fn(), doRedo: vi.fn() } as unknown as Engine;
}

const OFF = ["#undo-btn", "#redo-btn", ".menu-btn", "#context-tab", "#docname", ".brand", "#workspace-toggle"];

describe("the title bar under Home", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("is inert and dimmed while Home is up, all but the Home button, and live again once it closes", async () => {
    const home = useHomeStore();
    home.bind({} as HomeCallbacks);
    const w = mount(TitleBar, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: makeEngine() } } });
    const bar = w.get("#titlebar").element;
    const homeBtn = w.get("#home-btn").element;

    expect(bar.querySelector("[inert]")).toBeNull();
    expect(bar.classList.contains("home-up")).toBe(false);

    home.visible = true;
    await nextTick();
    for (const sel of OFF) expect(w.get(sel).element.closest("[inert]"), sel).not.toBeNull();
    expect(homeBtn.closest("[inert]")).toBeNull();
    expect(homeBtn.classList.contains("active")).toBe(true);
    expect(homeBtn.getAttribute("aria-pressed")).toBe("true");
    expect(bar.classList.contains("home-up")).toBe(true);

    home.visible = false;
    await nextTick();
    expect(bar.querySelector("[inert]")).toBeNull();
    expect(homeBtn.classList.contains("active")).toBe(false);
    expect(homeBtn.getAttribute("aria-pressed")).toBe("false");
    expect(bar.classList.contains("home-up")).toBe(false);
  });

  it("stays live while Home is asked for but has nothing to show", async () => {
    const home = useHomeStore();
    home.visible = true;
    const w = mount(TitleBar, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: makeEngine() } } });
    await nextTick();
    expect(w.get("#titlebar").element.querySelector("[inert]")).toBeNull();
  });
});
