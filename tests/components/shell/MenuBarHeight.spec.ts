import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import MenuBar from "../../../src/components/shell/MenuBar.vue";

enableAutoUnmount(afterEach);

// The popup is teleported to the body, so its rows are found there.
const rows = () => document.body.querySelector<HTMLElement>(".menubar-rows")!;
const items = Array.from({ length: 40 }, (_, i) => ({ label: `Item ${i}`, onClick: () => {} }));

describe("menubar popup height", () => {
  it("is capped to the window below the bar, minus the popup gap and a margin", async () => {
    vi.stubGlobal("innerHeight", 900);
    const w = mount(MenuBar, { props: { menus: [{ label: "View", items }] }, attachTo: document.body });
    vi.spyOn(w.element, "getBoundingClientRect").mockReturnValue({ bottom: 40 } as DOMRect);
    await w.get(".menu-btn").trigger("click");
    await nextTick();
    expect(rows().getAttribute("style")).toContain("max-height: 838px");
    vi.unstubAllGlobals();
  });

  it("re-measures when the window gets shorter", async () => {
    const w = mount(MenuBar, { props: { menus: [{ label: "View", items }] }, attachTo: document.body });
    vi.spyOn(w.element, "getBoundingClientRect").mockReturnValue({ bottom: 40 } as DOMRect);
    vi.stubGlobal("innerHeight", 500);
    await w.get(".menu-btn").trigger("click");
    await nextTick();
    expect(rows().getAttribute("style")).toContain("max-height: 438px");
    vi.unstubAllGlobals();
  });
});
