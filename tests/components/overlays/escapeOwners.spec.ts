// The menu bar and the command palette own the next Escape while open, so a
// screen under them (Home, a tool, a sketch) leaves that Escape to them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { escapeClaimed } from "../../../src/ui/escapeClaim";
import { useCommandPaletteStore } from "../../../src/stores/commandPalette";
import MenuBar from "../../../src/components/shell/MenuBar.vue";
import CommandPalette from "../../../src/components/overlays/CommandPalette.vue";

enableAutoUnmount(afterEach);
const later = () => new Promise((r) => setTimeout(r, 0));

describe("Escape owners", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("an open menu claims Escape until it closes", async () => {
    const w = mount(MenuBar, {
      props: { menus: [{ label: "File", items: [{ label: "Home", onClick: () => {} }] }] },
      attachTo: document.body,
    });
    expect(escapeClaimed()).toBe(false);
    await w.find(".menu-btn").trigger("click");
    expect(escapeClaimed()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    await later();
    expect(escapeClaimed()).toBe(false);
  });

  it("the open palette claims Escape until it closes", async () => {
    mount(CommandPalette, { attachTo: document.body });
    const cmdk = useCommandPaletteStore();
    cmdk.toggle("model");
    await nextTick();
    expect(escapeClaimed()).toBe(true);
    cmdk.close();
    await nextTick();
    await later();
    expect(escapeClaimed()).toBe(false);
  });
});
